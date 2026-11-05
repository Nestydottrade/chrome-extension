import { erc20Abi, type Address, type PublicClient } from 'viem';
import { CHAINS, getChain, type ChainConfig } from '../shared/chains';
import type { Detection } from '../shared/detection';
import {
  CONTENT_TYPES,
  FRAME_TYPES,
  RequestSchema,
  SITE_TYPES,
  type ErrorCode,
  type Request,
  type RequestType,
  type ResponseMap,
  type Result,
} from '../shared/messages';
import type { ChainSettings } from '../shared/settings/defaults';
import { costBasis } from '../shared/pnl';
import { openCard, type PnlCard } from '../shared/pnl-card';
import { isSolana, type SolAddress } from '../shared/solana';
import { hasEvm } from '../shared/wallet';
import { readBalances } from './balances';
import type { HistoryStore } from './history';
import type { LogoService } from './logos';
import { WSOL_MINT } from './solana/address';
import { panelQuotes, panelState } from './panel';
import type { PortfolioService } from './portfolio';
import type { WsStatus } from './ws';
import { resolveTarget } from './resolve';
import type { SolanaService } from './solana/service';
import type { SenderKind } from './sender';
import { SiteError, type SiteService } from './site';
import { AlertError } from './alerts';
import { TrackerError } from './tracker';
import { SettingsError, type SettingsStore } from './settings';
import type { ExitWatcher } from './exits';
import type { AggregatorCheck } from './trade/aggregator-check';
import { TradeError, chainContext, type TradeEngine } from './trade/engine';
import type { PriceService } from './trade/prices';
import type { Routing } from './trade/routing';
import type { TaxService } from './trade/tax';
import type { VenueCtx } from './trade/types';
import { poolKeyFromId } from './trade/uniswap/venue';
import { VaultError, type Vault } from './vault/vault';

export interface SiteControl {
  status(origin: string): Promise<{ builtin: boolean; enabled: boolean }>;
  enable(origin: string, tabId: number): Promise<{ builtin: boolean; enabled: boolean }>;
  disable(origin: string): Promise<{ builtin: boolean; enabled: boolean }>;
}

export interface RouterDeps {
  history: HistoryStore;
  portfolio: PortfolioService;
  logos: LogoService;
  exits: ExitWatcher;
  wsStatus: (chainId: number) => WsStatus;
  /** Pings the chain's RPC endpoints so their connections stay open (throttled). */
  warmRpc: (chainId: number) => Promise<void>;
  /** Called after a chain's settings change (e.g. to (re)connect its WebSocket). */
  onChainSettings: (chainId: number) => void;
  vault: Vault;
  settings: SettingsStore;
  engine: TradeEngine;
  /** Solana: pump.fun trading, balances and holdings. */
  solana: SolanaService;
  routing: Routing;
  tax: TaxService;
  aggregatorCheck?: Pick<AggregatorCheck, 'trusted'>;
  prices: PriceService;
  sites: SiteControl;
  /** The Nesty website: its connection and the trades it asks to sign. */
  site: SiteService;
  client: (chain: ChainConfig, cs: ChainSettings) => PublicClient;
  fetchJson: (url: string) => Promise<unknown>;
  aggregator?: VenueCtx['aggregator'];
  version: string;
  now: () => number;
  /** Called after unlock and after any user-initiated action: restarts the auto-lock timer. */
  onActivity: () => Promise<void>;
  onLockChanged: (unlocked: boolean) => Promise<void>;
  scheduleClipboardClear: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  /** Keeps a PnL card for its window and brings the window up. */
  openShare: (card: PnlCard) => Promise<void>;
}

export interface MessageMeta {
  kind: SenderKind;
  tabId?: number | undefined;
  /** The sender's origin (for a content script: the trading site's). */
  origin?: string | undefined;
}

/** Read-only or background-housekeeping requests that do not count as user activity. */
const PASSIVE: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'vault.lock',
  'vault.reset',
  'settings.get',
  'settings.repairs',
  'settings.getChain',
  'offscreen.done',
  'clipboard.scheduleClear',
  'panel.resolve',
  'panel.state',
  'panel.quotes',
  'exits.list',
  'exits.get',
  'panel.getPrefs',
  'panel.setPrefs',
  'rpc.warm',
  'sites.status',
  'wallets.balances',
  'history.list',
  'send.prepare',
  'send.checkRecipient',
  'portfolio.get',
  'logo.get',
  'logo.chain',
  'bridge.quote',
  'ws.status',
  'sol.panel.state',
  'sol.panel.quotes',
  'sol.rpc.warm',
  'sol.settings.get',
  'sol.send.prepare',
  'sol.send.checkRecipient',
  'site.hello',
  'site.wallets',
  'site.alerts.list',
  'site.tracker.feed',
  'site.pending',
  'site.connections',
]);

export function isAllowed(kind: SenderKind, type: RequestType): boolean {
  if (kind === 'extension-page') return true;
  if (kind === 'extension-frame') return FRAME_TYPES.has(type);
  if (kind === 'nesty-site') return SITE_TYPES.has(type);
  return CONTENT_TYPES.has(type);
}

export async function handleMessage(
  raw: unknown,
  meta: MessageMeta,
  deps: RouterDeps,
): Promise<Result<unknown>> {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return fail('invalid_request');
  const req = parsed.data;
  if (!isAllowed(meta.kind, req.type)) return fail('forbidden');

  try {
    const data = await dispatch(req, meta, deps);
    if (!PASSIVE.has(req.type) && (await deps.vault.isUnlocked())) await deps.onActivity();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof VaultError) {
      return err.retryAfterMs !== undefined
        ? { ok: false, error: err.code, retryAfterMs: err.retryAfterMs }
        : fail(err.code);
    }
    if (err instanceof TradeError) {
      if (!err.detail) return fail(err.code);
      return {
        ok: false,
        error: err.code,
        detail: err.detail,
        ...(err.actions && { actions: err.actions }),
      };
    }
    if (err instanceof SettingsError)
      return { ok: false, error: 'invalid_settings', detail: err.message };
    if (err instanceof SiteError) return fail(err.code);
    if (err instanceof AlertError) return fail(err.code);
    if (err instanceof TrackerError) return fail(err.code);
    if (err instanceof Error && err.message === 'unsupported_chain')
      return fail('unsupported_chain');
    if (err instanceof Error && err.message === 'permission_denied')
      return fail('permission_denied');
    // Deliberately no logging: errors here may be derived from wallet state.
    return fail('internal');
  }
}

async function dispatch(
  req: Request,
  meta: MessageMeta,
  d: RouterDeps,
): Promise<ResponseMap[RequestType]> {
  switch (req.type) {
    case 'ping':
      return { version: d.version, locked: !(await d.vault.isUnlocked()) };
    case 'vault.status':
      return { exists: await d.vault.exists(), unlocked: await d.vault.isUnlocked() };
    case 'vault.create': {
      const r = await d.vault.create(req.mnemonic, req.password);
      await d.onLockChanged(true);
      return r;
    }
    case 'vault.unlock': {
      const r = await d.vault.unlock(req.password);
      await d.onLockChanged(true);
      return r;
    }
    case 'vault.lock':
      await d.vault.lock();
      await d.onLockChanged(false);
      return null;
    case 'vault.reset':
      await d.vault.reset();
      await d.onLockChanged(false);
      return null;
    case 'vault.changePassword':
      await d.vault.changePassword(req.password, req.newPassword);
      return null;
    case 'wallets.list':
      return d.vault.listAccounts();
    case 'wallets.add':
      return d.vault.addDerived(req.name);
    case 'wallets.importKey':
      return d.vault.importPrivateKey(req.privateKey, req.name);
    case 'wallets.rename':
      await d.vault.rename(req.id, req.name);
      return null;
    case 'wallets.setHidden':
      await d.vault.setHidden(req.id, req.hidden);
      return null;
    case 'wallets.setPrimary':
      await d.vault.setPrimary(req.id);
      return null;
    case 'wallets.remove':
      await d.vault.remove(req.id);
      return null;
    case 'wallets.exportKey':
      return {
        privateKey:
          req.kind === 'solana'
            ? await d.vault.exportSolanaKey(req.id, req.password)
            : await d.vault.exportPrivateKey(req.id, req.password),
      };
    case 'wallets.balances': {
      if (isSolana(req.chainId)) {
        const accounts = await d.vault.listAccounts();
        const owners = accounts.flatMap((a) => (a.solana ? [a.solana] : []));
        const b = await d.solana.balances(owners, null, null);
        return accounts.map((a) => ({
          id: a.id,
          native: (b[a.solana ? owners.indexOf(a.solana) : -1]?.native ?? 0n).toString(),
        }));
      }
      const { ctx } = await chainContext(d, req.chainId);
      const accounts = (await d.vault.listAccounts()).filter(hasEvm);
      const b = await readBalances(
        ctx.client,
        null,
        accounts.map((a) => a.address),
      );
      return accounts.map((a, i) => ({ id: a.id, native: (b[i]?.native ?? 0n).toString() }));
    }
    case 'wallets.distribute':
      return isSolana(req.chainId) ? d.solana.transfers.distribute(req) : d.engine.distribute(req);
    case 'wallets.collect':
      return isSolana(req.chainId) ? d.solana.transfers.collect(req) : d.engine.collect(req);
    case 'send.prepare':
      return d.engine.sendPrep(req);
    case 'send.checkRecipient':
      return d.engine.checkRecipient(req, await d.history.list());
    case 'send.execute':
      return d.engine.send(req);
    case 'clipboard.scheduleClear':
      await d.scheduleClipboardClear();
      return null;
    case 'offscreen.done':
      await d.closeOffscreen();
      return null;
    case 'settings.get':
      return d.settings.get();
    case 'settings.repairs':
      return d.settings.repairs();
    case 'settings.update':
      return d.settings.update(stripUndefined(req.patch));
    case 'settings.getChain':
      return d.settings.getChain(req.chainId);
    case 'settings.updateChain': {
      const next = await d.settings.updateChain(req.chainId, stripUndefined(req.patch));
      d.onChainSettings(req.chainId);
      return next;
    }
    case 'history.list':
      return d.history.list();
    case 'approvals.list': {
      // Tokens Nesty knows on this chain: held, added, or ever traded.
      const [known, history] = await Promise.all([
        d.portfolio.knownTokens(req.chainId),
        d.history.list(),
      ]);
      const traded = history.flatMap((t) =>
        t.chainId === req.chainId && t.token ? [t.token] : [],
      );
      return d.engine.approvals(req.chainId, [...traded, ...known]);
    }
    case 'approvals.revoke':
      return d.engine.revoke(req.chainId, req.walletId, req.token, req.spender);
    case 'exits.list':
      return d.exits.list(req.chainId);
    case 'exits.get':
      return d.exits.get(req.chainId, req.token);
    case 'exits.set':
      return d.exits.set(req);
    case 'exits.remove':
      await d.exits.remove(req.chainId, req.token);
      return null;
    case 'token.supply': {
      if (isSolana(req.chainId)) {
        const meta = await d.solana.tokenMeta(req.token as SolAddress).catch(() => null);
        return meta ? meta.supply.toString() : null;
      }
      const { ctx } = await chainContext(d, req.chainId);
      try {
        const supply = await ctx.client.readContract({
          address: req.token as Address,
          abi: erc20Abi,
          functionName: 'totalSupply',
        });
        return supply.toString();
      } catch {
        return null;
      }
    }
    case 'share.open': {
      const card = openCard({
        ...req,
        supply: req.supply ?? null,
        history: await d.history.list(),
        now: d.now(),
      });
      // The panel and the popup offer a card only beside a PnL figure, so this is not expected.
      if (!card) throw new Error('no_card');
      await d.openShare(card);
      return null;
    }
    case 'portfolio.get': {
      if (isSolana(req.chainId)) return d.solana.portfolio(req.walletIds);
      const { ctx } = await chainContext(d, req.chainId);
      const accounts = (await d.vault.listAccounts()).filter(hasEvm);
      const wallets = accounts.filter((a) => req.walletIds.includes(a.id));
      // Valuing holdings must not send every held token to the aggregator.
      const [portfolio, history] = await Promise.all([
        d.portfolio.get({ ...ctx, aggregator: undefined }, wallets),
        d.history.list(),
      ]);
      // What each wallet paid for the tokens Nesty bought, for the open PnL.
      return {
        ...portfolio,
        tokens: portfolio.tokens.map((t) => {
          const basis = costBasis(history, req.chainId, t.address);
          if (basis.size === 0) return t;
          const cost = Object.fromEntries(
            [...basis].map(([id, c]) => [
              id,
              { tokens: c.tokens.toString(), costWei: c.costWei.toString() },
            ]),
          );
          return { ...t, cost };
        }),
      };
    }
    case 'portfolio.addToken':
      await d.portfolio.addTokens(req.chainId, [req.token]);
      return null;
    case 'portfolio.setTrusted':
      await d.portfolio.setTrusted(req.chainId, req.token, req.trusted);
      return null;
    case 'logo.get': {
      if (!(await d.settings.get()).showTokenLogos) return null;
      if (isSolana(req.chainId)) {
        // SOL itself is shown as wrapped SOL; a token's image is named by its metadata.
        if (req.token === 'native') return d.logos.solana(WSOL_MINT, null);
        const meta = await d.solana.tokenMeta(req.token).catch(() => null);
        return d.logos.solana(req.token, meta?.uri ?? null);
      }
      const chain = getChain(req.chainId);
      return chain ? d.logos.get(chain, req.token as Address | 'native') : null;
    }
    case 'logo.chain': {
      if (!(await d.settings.get()).showTokenLogos) return null;
      const slug = isSolana(req.chainId) ? 'solana' : getChain(req.chainId)?.dexscreenerSlug;
      return slug ? d.logos.chain(slug) : null;
    }
    case 'bridge.quote':
      return isSolana(req.fromChainId) ? d.solana.bridge.quote(req) : d.engine.bridgeQuote(req);
    case 'bridge.execute':
      return isSolana(req.fromChainId) ? d.solana.bridge.bridge(req) : d.engine.bridge(req);
    case 'ws.status':
      return d.wsStatus(req.chainId);
    case 'sites.status':
      return d.sites.status(req.origin);
    case 'sites.enable':
      return d.sites.enable(req.origin, req.tabId);
    case 'sites.disable':
      return d.sites.disable(req.origin);
    case 'panel.resolve': {
      const gs = await d.settings.get();
      const detection = stripUndefined(req.detection) as Detection;
      if (detection.solana)
        return d.solana.resolve(
          detection.solana,
          detection.kind,
          gs.usePoolIndex ? d.fetchJson : undefined,
        );
      // Per-chain settings up front so the user's custom RPCs are used here too.
      const chainSettings = new Map(
        await Promise.all(
          [...CHAINS.values()].map(async (c) => [c.id, await d.settings.getChain(c.id)] as const),
        ),
      );
      const clientFor = (chain: ChainConfig) =>
        d.client(chain, chainSettings.get(chain.id) as ChainSettings);
      return resolveTarget(detection, {
        client: clientFor,
        ...(gs.usePoolIndex ? { fetchJson: d.fetchJson } : {}),
        poolIdResolvers: [
          async (chain, poolId) => {
            const key = await poolKeyFromId(
              { chain, client: clientFor(chain), now: d.now },
              poolId,
            );
            if (!key) return null;
            const native = chain.wrappedNative.toLowerCase();
            const c0 = key.currency0.toLowerCase();
            // The traded token is the side that is not native/wrapped native.
            return c0 === '0x0000000000000000000000000000000000000000' || c0 === native
              ? key.currency1
              : key.currency0;
          },
        ],
      });
    }
    case 'panel.state':
      return panelState(d, req.chainId, req.token);
    case 'panel.quotes':
      return panelQuotes(d, req);
    case 'rpc.warm':
      await d.warmRpc(req.chainId);
      return null;
    case 'panel.selectWallets': {
      const accounts = await d.vault.listAccounts();
      const ids = req.walletIds.filter((id) => accounts.some((a) => a.id === id));
      await d.settings.update({ selectedWalletIds: ids });
      return null;
    }
    case 'panel.saveGroup': {
      const [gs, accounts] = await Promise.all([d.settings.get(), d.vault.listAccounts()]);
      const ids = req.walletIds.filter((id) => accounts.some((a) => a.id === id));
      const group = { id: crypto.randomUUID(), name: req.name, walletIds: ids };
      // The schema refuses a tenth group or an empty one.
      await d.settings.update({ walletGroups: [...gs.walletGroups, group] });
      return group;
    }
    case 'panel.setMultiWallet':
      await d.settings.update({ multiWalletMode: req.mode });
      return null;
    case 'panel.setTrade':
      await d.settings.updateChain(req.chainId, stripUndefined(req.patch));
      return null;
    case 'panel.getPrefs':
      return d.settings.panelPrefs(meta.origin);
    case 'panel.setPrefs':
      await d.settings.setPanelPrefs(meta.origin, req.prefs);
      return null;
    case 'trade.buy':
      return d.engine.buy(req, meta.tabId);
    case 'trade.sell':
      return d.engine.sell(req, meta.tabId);
    case 'trade.speedUp':
      return d.engine.replace(req.ticketId, req.walletId, 'speedUp');
    case 'trade.unstick':
      return d.engine.unstick(req.ticketId, req.walletId);
    case 'trade.cancel':
      return d.engine.replace(req.ticketId, req.walletId, 'cancel');
    case 'sol.panel.state':
      return d.solana.panelState(req.mint);
    case 'sol.panel.quotes':
      return d.solana.panelQuotes(req);
    case 'sol.panel.setTrade':
      await d.settings.updateSolana(stripUndefined(req.patch));
      return null;
    case 'sol.rpc.warm':
      await d.solana.warm();
      return null;
    case 'sol.trade.buy':
      return d.solana.buy(req, meta.tabId);
    case 'sol.trade.sell':
      return d.solana.sell(req, meta.tabId);
    case 'sol.settings.get':
      return d.settings.getSolana();
    case 'sol.settings.update':
      return d.settings.updateSolana(stripUndefined(req.patch));
    case 'sol.portfolio.setTrusted':
      await d.solana.setTrusted(req.mint, req.trusted);
      return null;
    case 'sol.send.prepare':
      return d.solana.transfers.sendPrep(req);
    case 'sol.send.checkRecipient':
      return d.solana.transfers.checkRecipient(req, await d.history.list());
    case 'sol.send.execute':
      return d.solana.transfers.send(req);
    case 'site.hello':
      return d.site.hello(siteOrigin(meta));
    case 'site.connect':
      return d.site.connect(siteOrigin(meta));
    case 'site.disconnect':
      await d.site.disconnect(siteOrigin(meta));
      return null;
    case 'site.wallets':
      return d.site.wallets(siteOrigin(meta));
    case 'site.unlock':
      await d.site.unlock();
      return null;
    case 'site.sol.sign':
      return d.site.signSolana(siteOrigin(meta), req);
    case 'site.evm.sign':
      return d.site.signEvm(siteOrigin(meta), req);
    case 'site.evm.permit':
      return d.site.signEvmPermit(siteOrigin(meta), req);
    case 'site.bridge.quote':
      return d.site.bridgeQuote(siteOrigin(meta), req);
    case 'site.bridge.send':
      return d.site.bridge(siteOrigin(meta), req);
    case 'site.bridge.status':
      return d.site.bridgeStatus(siteOrigin(meta), req.id);
    case 'site.alerts.list':
      return d.site.alerts(siteOrigin(meta));
    case 'site.alerts.set':
      return d.site.setAlert(siteOrigin(meta), req);
    case 'site.tracker.feed':
      return d.site.trackerFeed(siteOrigin(meta));
    case 'site.tracker.follow':
      return d.site.follow(siteOrigin(meta), req);
    case 'site.tracker.unfollow':
      return d.site.unfollow(siteOrigin(meta), req.id);
    case 'site.tracker.edit':
      return d.site.editFollow(siteOrigin(meta), req);
    case 'site.tracker.prefs':
      return d.site.trackerPrefs(siteOrigin(meta), req.minUsd);
    case 'site.alerts.remove':
      await d.site.removeAlert(siteOrigin(meta), req.id);
      return null;
    case 'site.pending':
      return d.site.pendingView(req.id);
    case 'site.decide':
      await d.site.decide(req.id, req.approve, req.password);
      return null;
    case 'site.connections':
      return d.site.connections();
    case 'site.revoke':
      await d.site.disconnect(req.origin);
      return null;
  }
}

/** The Nesty website's origin, as the sender check vouched for it. */
function siteOrigin(meta: MessageMeta): string {
  if (meta.kind !== 'nesty-site' || !meta.origin) throw new SiteError('not_connected');
  return meta.origin;
}

function fail(error: ErrorCode): Result<never> {
  return { ok: false, error };
}

function stripUndefined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
