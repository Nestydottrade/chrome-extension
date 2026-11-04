import { base58, base64 } from '@scure/base';
import { formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatCompact } from '../shared/format';
import type { BridgeQuoteView, RequestOf } from '../shared/messages';
import { nativeSymbol, networkName } from '../shared/networks';
import type { TradeTicket } from '../shared/panel';
import type { GlobalSettings } from '../shared/settings/defaults';
import type {
  SiteAlert,
  SiteAlerts,
  SiteBridgeRequest,
  SiteBridgeStarted,
  SiteBridgeStatus,
  SiteEvmSigned,
  SiteHello,
  SitePendingView,
  SiteSolSigned,
  SiteWallet,
  SolCreateIntent,
  SolTradeIntent,
  WireInstruction,
} from '../shared/site-bridge';
import { nativeDecimals } from '../shared/solana';
import { hasEvm, type EvmAccount, type WalletAccount } from '../shared/wallet';
import type { AlertWatcher } from './alerts';
import type { SettingsStore } from './settings';
import { publicKeyOf, signMessage } from './solana/keys';
import type { SiteTradeCheck } from './solana/service';
import { compileMessage, serializeTransaction, type Instruction } from './solana/tx';
import { bridgeDestination } from './trade/bridge-to';
import { TradeError } from './trade/engine';
import {
  permitPurposeFromWire,
  purposeFromWire,
  signPermit,
  signatureOf,
  txFromWire,
} from './trade/signer';
import type { SiteEvmCheck, SiteEvmChecker } from './trade/site-evm';
import { VaultError, type KeyValueStore, type Vault } from './vault/vault';

/**
 * The Nesty website's side of the extension. There the extension keeps the keys and
 * nothing else: the site finds coins, quotes, builds and sends its transactions itself.
 * The user lets the site in once (an approval window); after that it may list the
 * wallets and ask for signatures on trades, Solana and EVM (with the approvals and
 * Permit2 messages EVM sells need), and on new coins. Each is checked again here as the
 * panel's trades are (built again from chain, the user's limits, the validator); buys
 * above the confirmation amount, or past a minute's budget, wait for the user, and every
 * new coin does. It may also ask for a bridge, which the extension quotes and sends
 * itself: to the user's own wallet like a buy, and to an outside address only once the
 * user approves it here (with the password above the confirmation amount, as a Send).
 * And it may keep price alerts here, which the extension checks and notifies of; they go
 * when the site is disconnected.
 * Nothing else is ever signed for it: no transfers, no messages, and no key leaves.
 */
export interface SiteDeps {
  vault: Pick<
    Vault,
    'exists' | 'isUnlocked' | 'listAccounts' | 'solanaKeyFor' | 'privateKeyFor' | 'verifyPassword'
  >;
  /** The extension's own bridges, EVM or Solana by the source chain. */
  bridge: {
    quote(req: SiteBridgeRequest): Promise<BridgeQuoteView>;
    send(
      req: SiteBridgeRequest & { confirmed: true; passwordChecked: boolean },
    ): Promise<TradeTicket>;
  };
  solana: {
    checkSiteTrade(
      wallet: string,
      ixs: readonly Instruction[],
      intent: SolTradeIntent,
    ): Promise<SiteTradeCheck>;
    checkSiteCreate(
      wallet: string,
      ixs: readonly Instruction[],
      intent: SolCreateIntent,
    ): Promise<SiteTradeCheck>;
  };
  /** EVM transactions and Permit2 messages, built again from their purpose (site-evm.ts). */
  evm: Pick<SiteEvmChecker, 'checkTx' | 'checkPermit' | 'noteSigned'>;
  /** The price alerts sites set (alerts.ts). */
  alerts: Pick<AlertWatcher, 'list' | 'add' | 'remove' | 'removeSite' | 'blocked'>;
  settings: Pick<SettingsStore, 'get'>;
  local: KeyValueStore;
  /** Opens the approval window for a pending request: its window id. */
  openApproval: (id: string) => Promise<number | undefined>;
  /** Opens the extension's popup in a window, to unlock. */
  openUnlock: () => Promise<number | undefined>;
  newId: () => string;
  version: string;
  now: () => number;
}

export class SiteError extends Error {
  constructor(readonly code: 'not_connected' | 'rejected') {
    super(code);
    this.name = 'SiteError';
  }
}

const CONNECTIONS_KEY = 'site.connections';
/** A request nobody answers is turned down after this long. */
const APPROVAL_TIMEOUT_MS = 120_000;
/** Bridges a site started that it can still follow. */
const BRIDGES_KEPT = 20;
/** The window buys are added up over, against maxUsdPerClick. */
const BUDGET_WINDOW_MS = 60_000;

interface Connection {
  origin: string;
  at: number;
}

interface Pending {
  view: SitePendingView;
  windowId?: number;
  settle: (approved: boolean) => void;
}

export class SiteService {
  private readonly pending = new Map<string, Pending>();
  /** A connection request already in front of the user, per site. */
  private readonly connecting = new Map<string, Promise<boolean>>();
  /** Buys signed per site lately: the minute's budget. */
  private readonly spent = new Map<string, { at: number; usd: number }[]>();
  /** Bridges sites started, by ticket id: their latest state, for each site to follow its own. */
  private readonly bridges = new Map<string, { origin: string; ticket: TradeTicket }>();
  private unlockWindow: number | undefined;

  constructor(private readonly d: SiteDeps) {}

  async hello(origin: string): Promise<SiteHello> {
    const [exists, unlocked, connected, gs] = await Promise.all([
      this.d.vault.exists(),
      this.d.vault.isUnlocked(),
      this.isConnected(origin),
      this.d.settings.get(),
    ]);
    return { version: this.d.version, exists, unlocked, connected, limits: limitsOf(gs) };
  }

  /** Lets the site in (the user approves it once), then lists the wallets. */
  async connect(origin: string): Promise<SiteWallet[]> {
    if (!(await this.d.vault.exists())) throw new VaultError('no_vault');
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
    if (!(await this.isConnected(origin))) {
      let asked = this.connecting.get(origin);
      if (!asked) {
        asked = this.ask({ kind: 'connect', origin }).finally(() => this.connecting.delete(origin));
        this.connecting.set(origin, asked);
      }
      if (!(await asked)) throw new SiteError('rejected');
      const list = (await this.connectionList()).filter((c) => c.origin !== origin);
      await this.d.local.set(CONNECTIONS_KEY, [...list, { origin, at: this.d.now() }]);
    }
    return this.walletList();
  }

  async disconnect(origin: string): Promise<void> {
    const list = await this.connectionList();
    await this.d.local.set(
      CONNECTIONS_KEY,
      list.filter((c) => c.origin !== origin),
    );
    this.spent.delete(origin);
    await this.d.alerts.removeSite(origin);
  }

  async wallets(origin: string): Promise<SiteWallet[]> {
    await this.requireConnected(origin);
    return this.walletList();
  }

  /** The price alerts this site set, and whether the browser shows their notifications. */
  async alerts(origin: string): Promise<SiteAlerts> {
    await this.requireConnected(origin);
    const [alerts, blocked] = await Promise.all([
      this.d.alerts.list(origin),
      this.d.alerts.blocked().catch(() => false),
    ]);
    return { alerts, blocked };
  }

  /** Keeps a price alert: no key and no funds are involved, so the vault may be locked. */
  async setAlert(origin: string, req: RequestOf<'site.alerts.set'>): Promise<SiteAlert> {
    await this.requireConnected(origin);
    return this.d.alerts.add(origin, {
      chainId: req.chainId,
      token: req.token,
      symbol: req.symbol,
      above: req.above,
      price: req.price,
      supply: req.supply,
    });
  }

  async removeAlert(origin: string, id: string): Promise<void> {
    await this.requireConnected(origin);
    await this.d.alerts.remove(origin, id);
  }

  /** Opens the popup to unlock in (one window at a time). */
  async unlock(): Promise<void> {
    if (this.unlockWindow !== undefined || (await this.d.vault.isUnlocked())) return;
    this.unlockWindow = await this.d.openUnlock();
  }

  connections(): Promise<Connection[]> {
    return this.connectionList();
  }

  /**
   * Signs one trade or new coin the site built, after checking it again. Returns only the
   * wallet's signature: the site adds a new coin's own and sends the transaction itself.
   */
  async signSolana(origin: string, req: RequestOf<'site.sol.sign'>): Promise<SiteSolSigned> {
    await this.requireConnected(origin);
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
    const wallet = (await this.d.vault.listAccounts()).find((a) => a.id === req.walletId);
    if (!wallet) throw new VaultError('not_found');
    if (!wallet.solana) throw new VaultError('no_solana');
    const ixs = req.instructions.map(fromWire);
    const intent = req.intent;
    const check =
      intent.kind === 'create'
        ? await this.d.solana.checkSiteCreate(wallet.solana, ixs, intent)
        : await this.d.solana.checkSiteTrade(wallet.solana, ixs, intent);
    if (!check.ok) throw new TradeError('blocked', check.reason, check.actions);

    const usd = intent.kind === 'create' || intent.side === 'buy' ? check.usd : null;
    if (intent.kind === 'create') {
      await this.askCreate(origin, wallet, check.summary, usd);
    } else {
      const why = usd === null ? null : this.needsUser(origin, usd, await this.d.settings.get());
      if (why) {
        const approved = await this.ask({
          kind: 'trade',
          origin,
          walletName: wallet.name,
          summary: check.summary,
          usd,
          why,
        });
        if (!approved) throw new SiteError('rejected');
      }
    }

    const message = compileMessage(wallet.solana, ixs, req.blockhash);
    // Throws when it would not fit in one packet: nothing worth signing.
    serializeTransaction(message, []);
    const secret = await this.d.vault.solanaKeyFor(wallet.id);
    let signature: Uint8Array;
    try {
      // The key must be the fee payer's: anything else would be a vault fault.
      if (publicKeyOf(secret) !== wallet.solana) throw new Error('Key mismatch');
      signature = signMessage(message.bytes, secret);
    } finally {
      secret.fill(0);
    }
    if (usd !== null) this.note(origin, usd);
    return { signature: base58.encode(signature) };
  }

  /**
   * Signs one EVM transaction the site built, after building it again from its purpose
   * and checking it. Returns only the signature: the site sends the transaction itself.
   */
  async signEvm(origin: string, req: RequestOf<'site.evm.sign'>): Promise<SiteEvmSigned> {
    const { wallet, own } = await this.evmWallet(origin, req.walletId);
    const tx = txFromWire(req.tx);
    const purpose = purposeFromWire(req.purpose);
    const check = await this.d.evm.checkTx(wallet, own, tx, purpose);
    if (purpose.kind === 'create') {
      if (!check.ok) throw new TradeError('blocked', check.reason, check.actions);
      await this.askCreate(origin, wallet, check.summary, check.usd);
    } else {
      await this.confirm(origin, wallet, check);
    }
    const account = privateKeyToAccount(await this.d.vault.privateKeyFor(wallet.id));
    // The key must be the wallet's: anything else would be a vault fault.
    if (account.address !== wallet.address) throw new Error('Key mismatch');
    const signed = await account.signTransaction({ type: 'eip1559', ...tx });
    this.d.evm.noteSigned(wallet, tx, purpose, check);
    if (check.ok && check.usd !== null) this.note(origin, check.usd);
    return { signature: signatureOf(signed) };
  }

  /** A Permit2 signature one of the site's sells needs, checked like its transactions. */
  async signEvmPermit(origin: string, req: RequestOf<'site.evm.permit'>): Promise<SiteEvmSigned> {
    const { wallet, own } = await this.evmWallet(origin, req.walletId);
    const purpose = permitPurposeFromWire(req.purpose);
    const check = await this.d.evm.checkPermit(wallet, own, req.chainId, purpose);
    await this.confirm(origin, wallet, check);
    const account = privateKeyToAccount(await this.d.vault.privateKeyFor(wallet.id));
    if (account.address !== wallet.address) throw new Error('Key mismatch');
    return { signature: await signPermit(account, req.chainId, purpose) };
  }

  /** A bridge's quote, for the site's form. */
  async bridgeQuote(origin: string, req: SiteBridgeRequest): Promise<BridgeQuoteView> {
    await this.requireConnected(origin);
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
    return this.d.bridge.quote(req);
  }

  /**
   * Starts a bridge the site asked for. One to the user's own wallet waits for them as a buy
   * does (above the confirmation amount, or past the minute's budget); one to an outside
   * address always does, in the approval window, which asks the password too above that
   * amount (a Send's rule).
   */
  async bridge(origin: string, req: SiteBridgeRequest): Promise<SiteBridgeStarted> {
    await this.requireConnected(origin);
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
    const accounts = await this.d.vault.listAccounts();
    const from = accounts.find((a) => a.id === req.fromWalletId);
    if (!from) throw new VaultError('not_found');
    const to = bridgeDestination(req, accounts);
    const [quote, gs] = await Promise.all([this.d.bridge.quote(req), this.d.settings.get()]);
    const usd = quote.amountInUsd;
    const needsPassword = to.outside && (usd === null || usd > gs.confirmAboveUsd);
    const why = to.outside
      ? null
      : usd === null
        ? 'Its dollar value is unknown.'
        : this.needsUser(origin, usd, gs);
    if (to.outside || why) {
      const coin = (chainId: number, raw: bigint) =>
        `${formatCompact(Number(formatUnits(raw, nativeDecimals(chainId))))} ${nativeSymbol(chainId)} on ${networkName(chainId)}`;
      const approved = await this.ask({
        kind: 'bridge',
        origin,
        walletName: from.name,
        summary: `${req.amount} ${nativeSymbol(req.fromChainId)} on ${networkName(req.fromChainId)}`,
        receive: coin(req.toChainId, BigInt(quote.amountOut)),
        usd,
        toChainId: req.toChainId,
        recipient: to.recipient,
        recipientName: to.outside ? null : to.name,
        needsPassword,
        why,
      });
      if (!approved) throw new SiteError('rejected');
    }
    const ticket = await this.d.bridge.send({
      ...req,
      confirmed: true,
      passwordChecked: needsPassword,
    });
    if (usd !== null) this.note(origin, usd);
    this.bridges.set(ticket.id, { origin, ticket });
    for (const id of [...this.bridges.keys()].slice(0, -BRIDGES_KEPT)) this.bridges.delete(id);
    return { id: ticket.id, ...bridgeStatus(ticket) };
  }

  /** How a bridge the site started stands; null for one it did not start, or forgotten. */
  bridgeStatus(origin: string, id: string): SiteBridgeStatus | null {
    const b = this.bridges.get(id);
    return b && b.origin === origin ? bridgeStatus(b.ticket) : null;
  }

  /** Every ticket's news passes here: the bridges sites started are kept up to date. */
  noteTicket(ticket: TradeTicket): void {
    const b = this.bridges.get(ticket.id);
    if (b) b.ticket = ticket;
  }

  private async evmWallet(
    origin: string,
    walletId: string,
  ): Promise<{ wallet: EvmAccount; own: EvmAccount['address'][] }> {
    await this.requireConnected(origin);
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
    const accounts = await this.d.vault.listAccounts();
    const wallet = accounts.find((a) => a.id === walletId);
    if (!wallet) throw new VaultError('not_found');
    if (!hasEvm(wallet)) throw new VaultError('no_evm');
    return { wallet, own: accounts.filter(hasEvm).map((a) => a.address) };
  }

  /** A refused check throws; a buy above the user's thresholds waits for their answer. */
  private async confirm(origin: string, wallet: WalletAccount, check: SiteEvmCheck) {
    if (!check.ok) throw new TradeError('blocked', check.reason, check.actions);
    const why =
      check.usd === null ? null : this.needsUser(origin, check.usd, await this.d.settings.get());
    if (!why) return;
    const approved = await this.ask({
      kind: 'trade',
      origin,
      walletName: wallet.name,
      summary: check.summary,
      usd: check.usd,
      why,
    });
    if (!approved) throw new SiteError('rejected');
  }

  /** A new coin is always the user's call. */
  private async askCreate(
    origin: string,
    wallet: WalletAccount,
    summary: string,
    usd: number | null,
  ): Promise<void> {
    const approved = await this.ask({
      kind: 'create',
      origin,
      walletName: wallet.name,
      summary,
      usd,
    });
    if (!approved) throw new SiteError('rejected');
  }

  pendingView(id: string): SitePendingView | null {
    return this.pending.get(id)?.view ?? null;
  }

  /**
   * The user's answer. A bridge to an outside address above the confirmation amount needs
   * the password: a wrong one throws and leaves the request open, to try again.
   */
  async decide(id: string, approved: boolean, password?: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    if (approved && p.view.kind === 'bridge' && p.view.needsPassword)
      await this.d.vault.verifyPassword(password ?? '');
    p.settle(approved);
  }

  /** A window closed: an approval in it is turned down, an unlock window is done. */
  windowClosed(windowId: number): void {
    if (windowId === this.unlockWindow) this.unlockWindow = undefined;
    for (const p of this.pending.values()) if (p.windowId === windowId) p.settle(false);
  }

  private needsUser(origin: string, usd: number, gs: GlobalSettings): string | null {
    if (usd > gs.confirmAboveUsd) return `Above your confirmation amount ($${gs.confirmAboveUsd}).`;
    const minute = this.recent(origin).reduce((sum, s) => sum + s.usd, 0);
    if (minute + usd > gs.maxUsdPerClick)
      return `Over $${gs.maxUsdPerClick} of buys and bridges from this site within a minute.`;
    return null;
  }

  private recent(origin: string) {
    const since = this.d.now() - BUDGET_WINDOW_MS;
    const list = (this.spent.get(origin) ?? []).filter((s) => s.at > since);
    this.spent.set(origin, list);
    return list;
  }

  private note(origin: string, usd: number): void {
    this.spent.set(origin, [...this.recent(origin), { at: this.d.now(), usd }]);
  }

  /** Puts a request in front of the user; false when they turn it down or let it lapse. */
  private ask(view: WithoutId<SitePendingView>): Promise<boolean> {
    const id = this.d.newId();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => entry.settle(false), APPROVAL_TIMEOUT_MS);
      const entry: Pending = {
        view: { ...view, id },
        settle: (approved) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          resolve(approved);
        },
      };
      this.pending.set(id, entry);
      this.d
        .openApproval(id)
        .then((windowId) => {
          if (windowId !== undefined) entry.windowId = windowId;
          else entry.settle(false);
        })
        .catch(() => entry.settle(false));
    });
  }

  private async isConnected(origin: string): Promise<boolean> {
    return (await this.connectionList()).some((c) => c.origin === origin);
  }

  private async requireConnected(origin: string): Promise<void> {
    if (!(await this.isConnected(origin))) throw new SiteError('not_connected');
  }

  private async connectionList(): Promise<Connection[]> {
    const raw = await this.d.local.get(CONNECTIONS_KEY);
    return Array.isArray(raw)
      ? raw.filter(
          (c): c is Connection =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Connection).origin === 'string' &&
            typeof (c as Connection).at === 'number',
        )
      : [];
  }

  private async walletList(): Promise<SiteWallet[]> {
    return (await this.d.vault.listAccounts()).map(siteWallet);
  }
}

/** Each member of a union without its id. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function siteWallet(a: WalletAccount): SiteWallet {
  return {
    id: a.id,
    name: a.name,
    evm: a.address ?? null,
    solana: a.solana ?? null,
    primary: a.primary,
    hidden: a.hidden,
  };
}

/** A bridge ticket as the site follows it. */
function bridgeStatus(t: TradeTicket): SiteBridgeStatus {
  const leg = t.legs[0];
  const deposit = leg?.hash ?? leg?.sig;
  return {
    status: t.status,
    relayStatus: t.bridge?.relayStatus ?? 'waiting',
    ...(deposit ? { deposit } : {}),
    ...(t.bridge?.outHash ? { payout: t.bridge.outHash } : {}),
    ...(leg?.error ? { error: leg.error } : {}),
  };
}

function limitsOf(gs: GlobalSettings) {
  return {
    maxUsdPerTx: gs.maxUsdPerTx,
    maxUsdPerClick: gs.maxUsdPerClick,
    confirmAboveUsd: gs.confirmAboveUsd,
    maxGasUsd: gs.maxGasUsd,
    unlimitedApprovals: gs.unlimitedApprovals,
    approvalBufferBps: gs.approvalBufferBps,
  };
}

function fromWire(ix: WireInstruction): Instruction {
  return {
    programId: ix.programId,
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: base64.decode(ix.data),
  };
}
