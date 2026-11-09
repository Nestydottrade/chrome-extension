import { base58, base64 } from '@scure/base';
import { formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatCompact } from '../shared/format';
import type { BridgeQuoteView, RequestOf } from '../shared/messages';
import { nativeSymbol, networkName } from '../shared/networks';
import type { QuoteSet, TradeTicket } from '../shared/panel';
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
  SiteTracker,
  SiteWallet,
  SolCreateIntent,
  SolTradeIntent,
  WireInstruction,
} from '../shared/site-bridge';
import { SOLANA_CHAIN_ID, nativeDecimals } from '../shared/solana';
import { hasEvm, type EvmAccount, type WalletAccount } from '../shared/wallet';
import type { AlertWatcher } from './alerts';
import type { SettingsStore } from './settings';
import type { TrackerWatcher } from './tracker';
import { publicKeyOf, signMessage } from './solana/keys';
import type { SiteTradeCheck, SolanaService } from './solana/service';
import { compileMessage, serializeTransaction, type Instruction } from './solana/tx';
import { bridgeDestination } from './trade/bridge-to';
import { TradeError, type BuyGate, type TradeEngine } from './trade/engine';
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
 * The Nesty website's side of the extension. The hosted site is in from the start; any
 * other (the development server) gets in once the user approves it in a window, as does the
 * hosted site after the user turns it off in the popup. Once in, it may list the wallets
 * and ask for buys and sells, Solana and EVM, which the extension makes with its own engine
 * as the panel's are (its routes and checks, the user's limits and the validator), with the
 * site's own trade settings, keeping them in its history and telling the site's tab how
 * each goes. Buys above the confirmation amount, or past a minute's budget, wait for the
 * user. It may also ask for signatures on new coins, which are always the user's call, and
 * on the trades an older site builds itself (with the approvals and Permit2 messages EVM
 * sells need), each built again here from chain and checked the same way. It may ask for a
 * bridge, which the extension quotes and sends itself: to the user's own wallet like a buy,
 * and to an outside address only once the user approves it here (with the password above
 * the confirmation amount, as a Send). And it may keep price alerts and followed wallets
 * here, which the extension checks and notifies of; they stay when the site is turned off,
 * and it sees them again once it is back in.
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
  /** Solana: the site's trades, made here, and the checks of what it builds itself. */
  solana: Pick<SolanaService, 'buy' | 'sell' | 'panelQuotes' | 'notePagePool'> & {
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
  /** EVM: the site's trades, made by the extension's engine. */
  engine: Pick<TradeEngine, 'buy' | 'sell' | 'replace'>;
  /** The panel's quotes (panel.ts), for the site's wallets: they keep routes and fees warm. */
  quotes: (req: {
    chainId: number;
    token: EvmAccount['address'];
    buyAmounts: string[];
    sellBps: number[];
    walletIds: readonly string[];
  }) => Promise<QuoteSet>;
  /** Tells a tab how a trade its site asked for goes. */
  pushTicket: (tabId: number, ticket: TradeTicket) => void;
  /** EVM transactions and Permit2 messages, built again from their purpose (site-evm.ts). */
  evm: Pick<SiteEvmChecker, 'checkTx' | 'checkPermit' | 'noteSigned'>;
  /** The price alerts sites set (alerts.ts). */
  alerts: Pick<AlertWatcher, 'list' | 'add' | 'remove' | 'blocked'>;
  /** The wallets sites follow (tracker.ts). */
  tracker: Pick<TrackerWatcher, 'feed' | 'follow' | 'unfollow' | 'edit' | 'setMinUsd'>;
  settings: Pick<SettingsStore, 'get'>;
  local: KeyValueStore;
  /**
   * In from the start, with no approval: the hosted site, which every build trusts by name.
   * Once the user turns it off, it waits for an approval like any other.
   */
  connectedByDefault: readonly string[];
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
/** Of the sites in from the start, those the user disconnected. */
const DISCONNECTED_KEY = 'site.disconnected';
/** A request nobody answers is turned down after this long. */
const APPROVAL_TIMEOUT_MS = 120_000;
/** Bridges a site started that it can still follow. */
const BRIDGES_KEPT = 20;
/** Trades a site asked for that it can still follow and replace. */
const TRADES_KEPT = 40;
/** The window buys are added up over, against maxUsdPerClick. */
const BUDGET_WINDOW_MS = 60_000;

interface Connection {
  origin: string;
  /** When the user approved it: 0 for a site in from the start. */
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
  /** Buys and sells sites asked for, by ticket id: whose, and the tab told of their news. */
  private readonly trades = new Map<string, { origin: string; tabId: number | undefined }>();
  private unlockWindow: number | undefined;

  constructor(private readonly d: SiteDeps) {}

  async hello(origin: string): Promise<SiteHello> {
    const [exists, unlocked, connected, gs] = await Promise.all([
      this.d.vault.exists(),
      this.d.vault.isUnlocked(),
      this.isConnected(origin),
      this.d.settings.get(),
    ]);
    return {
      version: this.d.version,
      exists,
      unlocked,
      connected,
      limits: limitsOf(gs),
      trades: true,
    };
  }

  /** Lets the site in, by the user's approval unless it is in already, then lists the wallets. */
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
      const off = await this.disconnectedList();
      if (off.includes(origin))
        await this.d.local.set(
          DISCONNECTED_KEY,
          off.filter((o) => o !== origin),
        );
    }
    return this.walletList();
  }

  /**
   * Turns a site off (the popup's Sites card: no site turns itself off). Its price alerts
   * and followed wallets stay, and keep notifying: once back in, it sees them again.
   */
  async disconnect(origin: string): Promise<void> {
    const list = await this.connectionList();
    await this.d.local.set(
      CONNECTIONS_KEY,
      list.filter((c) => c.origin !== origin),
    );
    const off = await this.disconnectedList();
    if (this.d.connectedByDefault.includes(origin) && !off.includes(origin))
      await this.d.local.set(DISCONNECTED_KEY, [...off, origin]);
    this.spent.delete(origin);
    for (const [id, t] of this.trades) if (t.origin === origin) this.trades.delete(id);
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

  /** The wallets this site follows and their trades. Public data only: the vault may be locked. */
  async trackerFeed(origin: string): Promise<SiteTracker> {
    await this.requireConnected(origin);
    return this.d.tracker.feed(origin);
  }

  async follow(origin: string, req: RequestOf<'site.tracker.follow'>): Promise<SiteTracker> {
    await this.requireConnected(origin);
    return this.d.tracker.follow(origin, { address: req.address, name: req.name });
  }

  async unfollow(origin: string, id: string): Promise<SiteTracker> {
    await this.requireConnected(origin);
    return this.d.tracker.unfollow(origin, id);
  }

  async editFollow(origin: string, req: RequestOf<'site.tracker.edit'>): Promise<SiteTracker> {
    await this.requireConnected(origin);
    return this.d.tracker.edit(origin, { id: req.id, name: req.name, alerts: req.alerts });
  }

  async trackerPrefs(origin: string, minUsd: number): Promise<SiteTracker> {
    await this.requireConnected(origin);
    return this.d.tracker.setMinUsd(origin, minUsd);
  }

  /** Opens the popup to unlock in (one window at a time). */
  async unlock(): Promise<void> {
    if (this.unlockWindow !== undefined || (await this.d.vault.isUnlocked())) return;
    this.unlockWindow = await this.d.openUnlock();
  }

  /**
   * A buy the site asked for, made by the extension's engine as the panel's are: its warm
   * routes, checks and limits, with the site's own trade settings, and kept in the
   * extension's history. Above the confirmation amount, or past the minute's budget, it
   * waits for the user in the approval window first.
   */
  async buy(
    origin: string,
    req: RequestOf<'site.trade.buy'>,
    tabId?: number,
  ): Promise<TradeTicket> {
    await this.requireTrading(origin);
    const ticket = await this.d.engine.buy(
      {
        chainId: req.chainId,
        token: req.token,
        amount: req.amount,
        walletIds: req.walletIds,
        mode: req.mode,
        confirmed: false,
        clickedAt: req.clickedAt,
        prefs: req.prefs,
        gate: this.gate(origin, req.chainId, req.walletIds),
      },
      tabId,
    );
    return this.own(origin, ticket, tabId);
  }

  /** A sell the site asked for. Sells pay the user's own wallets: none waits for them. */
  async sell(
    origin: string,
    req: RequestOf<'site.trade.sell'>,
    tabId?: number,
  ): Promise<TradeTicket> {
    await this.requireTrading(origin);
    const ticket = await this.d.engine.sell(
      {
        chainId: req.chainId,
        token: req.token,
        bps: req.bps,
        walletIds: req.walletIds,
        confirmed: true,
        clickedAt: req.clickedAt,
        prefs: req.prefs,
      },
      tabId,
    );
    return this.own(origin, ticket, tabId);
  }

  /** The site panel's quotes, for its wallets: asked for again every second or two. */
  async quotes(origin: string, req: RequestOf<'site.trade.quotes'>): Promise<QuoteSet> {
    await this.requireConnected(origin);
    return this.d.quotes({
      chainId: req.chainId,
      token: req.token,
      buyAmounts: req.buyAmounts,
      sellBps: req.sellBps,
      walletIds: req.walletIds,
    });
  }

  /** Speeds up or cancels a wallet's transaction still waiting, in a trade the site asked for. */
  async replace(origin: string, req: RequestOf<'site.trade.replace'>): Promise<TradeTicket> {
    await this.requireTrading(origin);
    if (this.trades.get(req.ticketId)?.origin !== origin) throw new TradeError('not_found');
    return this.d.engine.replace(req.ticketId, req.walletId, req.mode);
  }

  /** A Solana buy the site asked for, as `buy` is. */
  async solBuy(
    origin: string,
    req: RequestOf<'site.sol.buy'>,
    tabId?: number,
  ): Promise<TradeTicket> {
    await this.requireTrading(origin);
    // A new curve the pool index may not list yet: its pools are read and checked there.
    if (req.pool) this.d.solana.notePagePool(req.mint, req.pool);
    const ticket = await this.d.solana.buy(
      {
        mint: req.mint,
        amount: req.amount,
        walletIds: req.walletIds,
        mode: req.mode,
        confirmed: false,
        clickedAt: req.clickedAt,
        prefs: req.prefs,
        gate: this.gate(origin, SOLANA_CHAIN_ID, req.walletIds),
      },
      tabId,
    );
    return this.own(origin, ticket, tabId);
  }

  async solSell(
    origin: string,
    req: RequestOf<'site.sol.sell'>,
    tabId?: number,
  ): Promise<TradeTicket> {
    await this.requireTrading(origin);
    const ticket = await this.d.solana.sell(
      {
        mint: req.mint,
        bps: req.bps,
        walletIds: req.walletIds,
        confirmed: true,
        clickedAt: req.clickedAt,
        prefs: req.prefs,
      },
      tabId,
    );
    return this.own(origin, ticket, tabId);
  }

  async solQuotes(origin: string, req: RequestOf<'site.sol.quotes'>): Promise<QuoteSet> {
    await this.requireConnected(origin);
    // As for a buy: a quick buy's coin is quoted ahead of the press on the pool it names.
    if (req.pool) this.d.solana.notePagePool(req.mint, req.pool);
    return this.d.solana.panelQuotes({
      mint: req.mint,
      buyAmounts: req.buyAmounts,
      sellBps: req.sellBps,
      walletIds: req.walletIds,
    });
  }

  /**
   * Whether the user sees one of the site's buys first, by its dollar value: above the
   * confirmation amount, or past the minute's budget, as for a trade the site asks to sign.
   */
  private gate(origin: string, chainId: number, walletIds: readonly string[]): BuyGate {
    return async ({ usd, spend, coin }) => {
      const why = this.needsUser(origin, usd, await this.d.settings.get());
      if (why) {
        const picked = (await this.d.vault.listAccounts()).filter((a) => walletIds.includes(a.id));
        const approved = await this.ask({
          kind: 'trade',
          origin,
          walletName: picked.length === 1 ? (picked[0]?.name ?? '') : `${picked.length} wallets`,
          summary: `Buy ${coin ?? 'a coin'} for ${spend} on ${networkName(chainId)}`,
          usd,
          why,
        });
        if (!approved) throw new SiteError('rejected');
      }
      this.note(origin, usd);
      return why !== null;
    };
  }

  /** Keeps a trade as the site's, to tell its tab how it goes and let it replace it. */
  private own(origin: string, ticket: TradeTicket, tabId: number | undefined): TradeTicket {
    this.trades.set(ticket.id, { origin, tabId });
    for (const id of [...this.trades.keys()].slice(0, -TRADES_KEPT)) this.trades.delete(id);
    return ticket;
  }

  /** The sites in now: those in from the start and not disconnected, then those approved. */
  async connections(): Promise<Connection[]> {
    const [list, off] = await Promise.all([this.connectionList(), this.disconnectedList()]);
    const fromStart = this.d.connectedByDefault
      .filter((origin) => !off.includes(origin) && !list.some((c) => c.origin === origin))
      .map((origin) => ({ origin, at: 0 }));
    return [...fromStart, ...list];
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

  /**
   * Every ticket's news passes here: the bridges sites started are kept up to date, and the
   * tab whose site asked for a trade is told how it goes.
   */
  noteTicket(ticket: TradeTicket): void {
    const b = this.bridges.get(ticket.id);
    if (b) b.ticket = ticket;
    const t = this.trades.get(ticket.id);
    if (t?.tabId !== undefined) this.d.pushTicket(t.tabId, ticket);
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
    return (await this.connections()).some((c) => c.origin === origin);
  }

  private async requireConnected(origin: string): Promise<void> {
    if (!(await this.isConnected(origin))) throw new SiteError('not_connected');
  }

  private async requireTrading(origin: string): Promise<void> {
    await this.requireConnected(origin);
    if (!(await this.d.vault.isUnlocked())) throw new VaultError('locked');
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

  private async disconnectedList(): Promise<string[]> {
    const raw = await this.d.local.get(DISCONNECTED_KEY);
    return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
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
