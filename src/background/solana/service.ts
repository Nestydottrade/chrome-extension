import { base58 } from '@scure/base';
import { formatUnits, parseUnits, type Address } from 'viem';
import { feedPairs, type FeedPair } from '../../shared/main-pair';
import type { Portfolio, PortfolioTokenView } from '../../shared/messages';
import type {
  BlockedAction,
  LegStatus,
  PanelState,
  PayCurrency,
  QuoteSet,
  QuoteView,
  TicketLeg,
  TicketSettings,
  TradeTicket,
} from '../../shared/panel';
import { costBasis } from '../../shared/pnl';
import { sanitizeLabel } from '../../shared/sanitize';
import {
  solanaPriorityFee,
  type GlobalSettings,
  type SolanaSettings,
} from '../../shared/settings/defaults';
import type { SolanaTarget } from '../../shared/detection';
import { SOLANA, SOLANA_CHAIN_ID, isSolAddress, type SolAddress } from '../../shared/solana';
import type { WalletAccount } from '../../shared/wallet';
import type { HistoryStore } from '../history';
import { DUST_USD } from '../portfolio';
import type { SettingsStore } from '../settings';
import { TradeError, markRefused, shortErr, sleep, walletAmounts } from '../trade/engine/core';
import { priceImpactBps } from '../trade/routing';
import type { KeyValueStore, Vault } from '../vault/vault';
import {
  METADATA_PROGRAM,
  STABLE_MINTS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  associatedTokenAddress,
  findProgramAddress,
  seed,
} from './address';
import { explainError } from './errors';
import { signMessage, publicKeyOf } from './keys';
import { EXT, decodeMetaplexMetadata, decodeMint, decodeTokenAccount } from './layouts';
import { SolPrice } from './price';
import {
  AMM_FEE_CONFIG,
  AMM_GLOBAL_CONFIG,
  MAX_HOPS,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  SOL_QUOTE,
  bondingCurveAddress,
  canonicalPoolAddress,
  curveIdle,
  curveQuoteMint,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeGlobal,
  decodePool,
  isSolQuote,
  isTokenProgram,
  pickRoute,
  routeCoin,
  routeIdle,
  routeSpotPrice,
  venueLabel,
  type AmmGlobalConfig,
  type FeeConfig,
  type PumpGlobal,
  type PumpRoute,
  type PumpVenue,
  type QuoteAsset,
  type Side,
} from './pump';
import { SolRpc, type AccountInfo, type TxMeta } from './rpc';
import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from './spl';
import { compileMessage, serializeTransaction, type Instruction } from './tx';
import type { RelayClient } from '../trade/relay';
import { SolBridgeFlow } from './bridge';
import {
  DEX_MODULES,
  batchedReader,
  dexModule,
  indexedPools,
  isDexQuote,
  moduleOf,
  type DexLoadCtx,
  type DexModule,
  type DexVenue,
} from './dex';
import { whirlpoolAddresses } from './dex/orca';
import { createIntentProblem } from '../../shared/create';
import type { SolCreateIntent, SolTradeIntent } from '../../shared/site-bridge';
import { devBuyQuote, freshRoute } from '../create/pump';
import {
  bestRoute,
  buyQuote,
  fundedBest,
  noFill,
  pumpRoute,
  routePay,
  sellQuote,
  spotPrice,
  tokenDelta,
  tradeBuilder,
  tradeDelivered,
  tradeUnits,
  validateTrade,
  type SolRoute,
} from './routes';
import { SolTransferFlow } from './transfers';
import { validatePumpCreate } from './validator';

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface SolanaDeps {
  vault: Vault;
  settings: SettingsStore;
  /** Which received tokens the user marked as their own, or hid. */
  local: KeyValueStore;
  history: Pick<HistoryStore, 'list'>;
  notify: (ticket: TradeTicket, tabId?: number) => void;
  fetchFn?: FetchFn;
  /** The pool index (DexScreener), used only while the user allows it. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Relay, for bridges from Solana. Without it, bridging from Solana is refused. */
  relay?: RelayClient;
  /** The symbol of the token contract at an EVM address, or null: an outside payout's check. */
  evmTokenAt?: (chainId: number, address: Address) => Promise<string | null>;
  /**
   * Signs a transaction's message for one wallet. The extension leaves it out and signs
   * with the vault's key; the Nesty website hands it to the extension, which checks the
   * trade again before it signs.
   */
  sign?: (req: SolSignRequest) => Promise<Uint8Array>;
  now: () => number;
}

export interface SolSignRequest {
  wallet: SolWallet;
  /** Compute budget included: exactly what the message holds. */
  instructions: readonly Instruction[];
  blockhash: string;
  message: Uint8Array;
  /** The trade it is, or null for a transfer (which only the extension signs). */
  intent: SolTradeIntent | null;
}

/** What checking a trade the Nesty website built found. */
export type SiteTradeCheck =
  | { ok: true; summary: string; usd: number | null }
  | { ok: false; reason: string; actions?: BlockedAction[] };

/** A refusal that names the decoded action, for the website to list. */
function refuseActions(actions: BlockedAction[]): SiteTradeCheck {
  return { ok: false, reason: actions.find((a) => !a.ok)?.reason ?? 'Blocked.', actions };
}

export interface SolTokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram: SolAddress;
  /** Supply when the mint was read (pump.fun coins are minted once, so it rarely moves). */
  supply: bigint;
  /** Token-2022 extension types of the mint (none for SPL Token mints). */
  extensions?: readonly number[];
  /** The program its transfer hook runs, when one is set. */
  hookProgram?: SolAddress;
  /** Its metadata JSON (for the logo), as the mint or its Metaplex account names it. */
  uri?: string;
}

/** Tokens the user marked as their own, and ones they hid (bought or not). */
interface TrustLists {
  trusted: SolAddress[];
  hidden: SolAddress[];
}

interface VenueResult {
  venue: PumpVenue | null;
  /** Why the token cannot be traded right now, when known. */
  idle: string | null;
  /** False when the mint is no pump.fun coin at all (it never had a curve). */
  pump?: boolean;
}

interface RouteResult {
  route: PumpRoute | null;
  idle: string | null;
}

interface MarketResult {
  /** The routes the coin trades by now, all in one pay currency; the most liquid first. */
  routes: SolRoute[];
  /** Why it cannot be traded right now, when known. */
  idle: string | null;
  /**
   * When that pay currency is a token: its pools against SOL. The coin is then bought and
   * sold with SOL, through the token, as EVM coins on a curve priced in a token are.
   */
  funding?: DexVenue[];
}

/** What a route pays with, priced. */
interface PayInfo {
  asset: QuoteAsset;
  symbol: string;
  decimals: number;
  /** USD per whole unit; null when unknown (buys then cannot be checked against limits). */
  usd: number | null;
  stable: boolean;
}

/** A coin's canonical pool, once found: read with the coin from then on. */
interface PoolKeys {
  quote: QuoteAsset;
  base: SolAddress;
  quoteVault: SolAddress;
}

interface Configs {
  at: number;
  global: PumpGlobal;
  pumpFees: FeeConfig;
  ammGlobal: AmmGlobalConfig;
  ammFees: FeeConfig;
}

export interface SolTicket {
  ticket: TradeTicket;
  tabId?: number | undefined;
  startedAt: number;
}

/** A wallet that has a Solana address: every wallet but one imported from an EVM key. */
export type SolWallet = WalletAccount & { solana: SolAddress };

/** One wallet's transaction, for runLeg. */
export interface SolLegJob {
  wallet: SolWallet;
  instructions: Instruction[];
  /** Compute units to ask for, before any simulation measures them. */
  units: number;
  /** Runs on the exact instructions, compute budget included, before every signature. */
  validate: (ixs: Instruction[]) => { ok: boolean; actions: BlockedAction[] };
  /** Why the wallet cannot pay for it, read alongside the blockhash; null when it can. */
  shortfall?: (rpc: SolRpc, priorityLamports: bigint) => Promise<string | null>;
  /** What the confirmed transaction delivered, in raw units, from its balances. */
  delivered?: (meta: TxMeta) => bigint;
  /** Runs once the transaction is confirmed without error. */
  onConfirmed?: () => void;
  /**
   * Runs once, when it is settled: with its balances once confirmed and read, else with
   * null (blocked, skipped, failed, expired, or its balances never came).
   */
  settled?: (meta: TxMeta | null) => void;
  /** The trade it is, for a signer that checks it again (the Nesty website's). */
  intent?: SolTradeIntent;
  gs: GlobalSettings;
  ss: SolanaSettings;
}

const VENUE_TTL_MS = 400;
/** A website's trade is checked against its pump.fun route read at most this long ago. */
const SITE_ROUTE_AGE_MS = 1_000;
const CONFIG_TTL_MS = 60_000;
/** A blockhash stays valid for ~60 s; one this old still leaves time to land. */
const BLOCKHASH_TTL_MS = 15_000;
const CONFIRM_POLL_MS = 800;
const REBROADCAST_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 120_000;
const TICKET_TTL_MS = 60 * 60_000;
const PRICE_TTL_MS = 30_000;
/** What a buy may need on top of its amount: new accounts' rent and the network fee. */
const BUY_HEADROOM = 6_000_000n;
/** Exit plans are checked about every second: their prices are read at most this old. */
const EXIT_QUOTE_AGE_MS = 900;
const MAX_CACHE = 200;
const TRUST_KEY = 'nesty.solana.trusted';
const MAX_TRUST = 1_000;
/** Holdings listed per call, the user's own first, and how many of those get a price. */
const MAX_TOKENS = 60;
const MAX_PRICED = 30;
/** Known mints (traded, added or hidden) read per call when the RPC cannot list holdings. */
const MAX_KNOWN = 100;
/** How long a coin's pools on other programs, as the index lists them, are kept. */
const POOLS_TTL_MS = 60_000;
/** ...and how soon the index is asked again after it failed. */
const POOLS_RETRY_MS = 10_000;
/** Pools of other programs quoted per coin, the most liquid first. */
const MAX_DEX_POOLS = 3;
/** Pools that turn SOL into a coin's pay token kept per token, the best for a SOL first. */
const MAX_FUNDING_LEGS = 2;
/** What those pools are ranked by: what they pay for this many lamports (1 SOL). */
const LEG_RANK_LAMPORTS = 1_000_000_000n;
/** Quotes read them at most this old: they move far less than a new coin's own pool. */
const LEG_AGE_MS = 1_500;
/** Slippage for turning SOL into a pay token and back: the deep pool's, not the user's. */
const FUNDING_SLIPPAGE_BPS = 100;
/** A u64's largest value: no limit in the validator, for a limit checked another way. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * Token-2022 rules pools cannot quote or trade through: a fee on every transfer, or a hook
 * that runs a program on every transfer (one set to no program runs nothing).
 */
const untradable = (meta: SolTokenMeta) =>
  !!meta.extensions?.includes(EXT.transferFeeConfig) || !!meta.hookProgram;

export const metadataAddress = (mint: SolAddress) =>
  findProgramAddress([seed('metadata'), METADATA_PROGRAM, mint], METADATA_PROGRAM);

function bounded<K, V>(map: Map<K, V>): Map<K, V> {
  if (map.size > MAX_CACHE) map.clear();
  return map;
}

/**
 * Solana in Nesty: quotes for the panel, balances, and buys and sells through pump.fun's
 * curve and PumpSwap, or the pools and launch curves of the programs in ./dex. Every
 * transaction passes its validator before it is signed, as on the EVM side.
 */
export class SolanaService {
  readonly price: SolPrice;
  /** Send, distribute and collect on Solana. */
  readonly transfers: SolTransferFlow;
  /** Bridges from Solana, through Relay. */
  readonly bridge: SolBridgeFlow;
  private rpcCache: { key: string; rpc: SolRpc } | null = null;
  private configs: Configs | null = null;
  private readonly venues = new Map<SolAddress, { at: number; result: VenueResult }>();
  private readonly venueLoads = new Map<SolAddress, Promise<VenueResult>>();
  private readonly pools = new Map<SolAddress, PoolKeys>();
  /** Token programs of quote mints (they never change). */
  private readonly quoteAssets = new Map<SolAddress, QuoteAsset>();
  /** Mints that are no pump.fun coin: a quote chain ends at them. */
  private readonly notPump = new Set<SolAddress>();
  /** The mints of each coin's quote chain, to read them all at once next time. */
  private readonly chains = new Map<SolAddress, SolAddress[]>();
  /** Each coin's pools on other programs, as the index lists them. */
  private readonly dexPools = new Map<
    SolAddress,
    { at: number; ttl: number; pools: SolAddress[] }
  >();
  /** Pools pages pointed at, per coin: quoted too, with or without the index. */
  private readonly pagePools = new Map<SolAddress, SolAddress[]>();
  /** The program owning each pool named (null: no such account). */
  private readonly poolOwners = new Map<SolAddress, SolAddress | null>();
  private readonly markets = new Map<SolAddress, { at: number; result: MarketResult }>();
  private readonly marketLoads = new Map<SolAddress, Promise<MarketResult>>();
  /** Each pay token's pools against SOL, as read last. */
  private readonly legs = new Map<SolAddress, { at: number; legs: DexVenue[] }>();
  private readonly legLoads = new Map<SolAddress, Promise<DexVenue[]>>();
  /** ...and which of its pools those are, ranked now and then (they rarely change). */
  private readonly legPools = new Map<
    SolAddress,
    { at: number; ttl: number; pools: SolAddress[] }
  >();
  private readonly usdPrices = new Map<SolAddress, { at: number; usd: number | null }>();
  private readonly metas = new Map<SolAddress, SolTokenMeta | null>();
  private readonly tickets = new Map<string, SolTicket>();
  private blockhashCache: {
    at: number;
    value: { blockhash: string; lastValidBlockHeight: number };
  } | null = null;

  constructor(private readonly d: SolanaDeps) {
    this.price = new SolPrice(() => this.rpc(), d.now);
    this.transfers = new SolTransferFlow(this, d);
    this.bridge = new SolBridgeFlow(this, d);
  }

  async rpc(): Promise<SolRpc> {
    return this.rpcFor(await this.d.settings.getSolana());
  }

  /** Internal: also used by SolTransferFlow. */
  rpcFor(ss: SolanaSettings): SolRpc {
    const urls = [...(ss.customRpc ? [ss.customRpc] : []), ...SOLANA.rpcUrls];
    const key = urls.join(' ');
    if (this.rpcCache?.key !== key) {
      this.rpcCache = { key, rpc: new SolRpc(urls, this.d.fetchFn) };
      this.blockhashCache = null;
    }
    return this.rpcCache.rpc;
  }

  /** Keeps the connection and a recent blockhash ready for the next click. */
  async warm(): Promise<void> {
    const rpc = await this.rpc();
    await this.blockhash(rpc).catch(() => undefined);
  }

  private async blockhash(rpc: SolRpc) {
    const c = this.blockhashCache;
    if (c && this.d.now() - c.at < BLOCKHASH_TTL_MS) return c.value;
    const value = await rpc.getLatestBlockhash();
    this.blockhashCache = { at: this.d.now(), value };
    return value;
  }

  // ── token data ────────────────────────────────────────────────────────────

  async tokenMeta(mint: SolAddress): Promise<SolTokenMeta | null> {
    return (await this.tokenMetas([mint]))[0] ?? null;
  }

  /** Names and decimals of many mints, reading the ones not cached in one batch. */
  async tokenMetas(mints: readonly SolAddress[]): Promise<(SolTokenMeta | null)[]> {
    const missing = [...new Set(mints.filter((m) => !this.metas.has(m)))];
    if (missing.length > 0) {
      const accs = await (
        await this.rpc()
      ).getMultipleAccounts(missing.flatMap((m) => [m, metadataAddress(m)]));
      missing.forEach((m, i) => {
        const meta = parseMeta(accs[i * 2] ?? null, accs[i * 2 + 1] ?? null);
        // A missing account may still appear (a coin seconds old): only found ones are kept.
        if (meta) bounded(this.metas).set(m, meta);
      });
    }
    return mints.map((m) => this.metas.get(m) ?? null);
  }

  // ── trust ─────────────────────────────────────────────────────────────────

  private async trustLists(): Promise<TrustLists> {
    const v = (await this.d.local.get(TRUST_KEY)) as Partial<TrustLists> | undefined;
    const list = (x: unknown) =>
      Array.isArray(x) ? x.filter((m): m is SolAddress => typeof m === 'string') : [];
    return { trusted: list(v?.trusted), hidden: list(v?.hidden) };
  }

  /**
   * Marks a received token as the user's own (shown and priced) or hides it. Tokens
   * bought through Nesty count as their own until hidden.
   */
  async setTrusted(mint: SolAddress, trusted: boolean): Promise<void> {
    const lists = await this.trustLists();
    const keep = (l: SolAddress[]) => l.filter((m) => m !== mint);
    const next: TrustLists = trusted
      ? { trusted: [...keep(lists.trusted), mint], hidden: keep(lists.hidden) }
      : { trusted: keep(lists.trusted), hidden: [...keep(lists.hidden), mint] };
    await this.d.local.set(TRUST_KEY, {
      trusted: next.trusted.slice(-MAX_TRUST),
      hidden: next.hidden.slice(-MAX_TRUST),
    });
  }

  /**
   * The token a page points at, checked on-chain: a mint itself, or the pump.fun curve,
   * PumpSwap pool or other program's pool of one. Any other address is looked up in the
   * pool index (`fetchJson`, when the user allows it) and the mint it names must exist.
   */
  async resolve(
    address: SolAddress,
    kind: 'token' | 'pair' | 'unknown',
    fetchJson?: (url: string) => Promise<unknown>,
  ): Promise<SolanaTarget | null> {
    const rpc = await this.rpc();
    const acc = await rpc.getAccount(address);
    const target = async (
      mint: SolAddress,
      source: SolanaTarget['source'],
    ): Promise<SolanaTarget | null> => {
      const meta = await this.tokenMeta(mint);
      if (!meta) return null;
      return {
        kind: 'solana',
        chainId: SOLANA_CHAIN_ID,
        mint,
        ...(mint !== address ? { pair: address } : {}),
        name: meta.name,
        symbol: meta.symbol,
        decimals: meta.decimals,
        source,
      };
    };
    if (acc && isTokenProgram(acc.owner) && decodeMint(acc.data)?.initialized)
      return target(address, 'url');
    if (kind === 'token') return null;

    if (acc?.owner === PUMP_AMM_PROGRAM) {
      const pool = decodePool(acc.data);
      if (pool) return target(pool.baseMint === WSOL_MINT ? pool.quoteMint : pool.baseMint, 'pair');
    }
    if (acc?.owner === PUMP_PROGRAM && decodeBondingCurve(acc.data)) {
      const mint = await this.curveMint(rpc, address).catch(() => null);
      if (mint) return target(mint, 'pair');
    }
    // A pool of another program Nesty trades on: its coin, and the pool to quote it on.
    const coin = acc ? moduleOf(acc.owner)?.coinOf(acc.data) : null;
    if (coin) {
      this.notePagePool(coin, address);
      return target(coin, 'pair');
    }
    if (!fetchJson) return null;
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`);
    const pair = (
      json as { pairs?: { baseToken?: { address?: string }; quoteToken?: { address?: string } }[] }
    )?.pairs?.[0];
    const base = pair?.baseToken?.address;
    const mint = base === WSOL_MINT ? pair?.quoteToken?.address : base;
    return mint && isSolAddress(mint) ? target(mint, 'api') : null;
  }

  /** A pool a page names for `mint`: quoted with the index's, before the index lists it. */
  notePagePool(mint: SolAddress, pool: SolAddress): void {
    const list = this.pagePools.get(mint) ?? [];
    if (!list.includes(pool)) bounded(this.pagePools).set(mint, [pool, ...list].slice(0, 3));
  }

  /**
   * The coin a pump.fun curve trades. The curve does not store its mint, but every trade
   * moves the coin in the curve's token account, so a recent transaction names it. (A
   * wallet-wide token account read would do it in one call, but public RPCs refuse it.)
   */
  private async curveMint(rpc: SolRpc, curve: SolAddress): Promise<SolAddress | null> {
    for (const sig of await rpc.getSignatures(curve, 3)) {
      const tx = await rpc.getTransactionMeta(sig, 1);
      const mint = tx?.postTokenBalances.find((b) => b.owner === curve)?.mint;
      if (mint && isSolAddress(mint) && bondingCurveAddress(mint) === curve) return mint;
    }
    return null;
  }

  /** The venue `mint` trades on now: its pump.fun curve, else its canonical PumpSwap pool. */
  async venue(mint: SolAddress, maxAgeMs = VENUE_TTL_MS): Promise<VenueResult> {
    const hit = this.venues.get(mint);
    if (hit && this.d.now() - hit.at <= maxAgeMs) return hit.result;
    let load = this.venueLoads.get(mint);
    if (!load) {
      load = this.loadVenue(mint)
        .then((result) => {
          bounded(this.venues).set(mint, { at: this.d.now(), result });
          if (result.pump === false) {
            if (this.notPump.size > MAX_CACHE * 5) this.notPump.clear();
            this.notPump.add(mint);
          }
          return result;
        })
        .finally(() => this.venueLoads.delete(mint));
      this.venueLoads.set(mint, load);
    }
    return load;
  }

  /**
   * How `mint` trades now: its own venue and, while it is quoted in another pump.fun coin,
   * that coin's venue, down to SOL or a token (the route pickRoute allows).
   */
  async route(mint: SolAddress, maxAgeMs = VENUE_TTL_MS): Promise<RouteResult> {
    // A chain seen before is read all at once; a new one hop by hop.
    const known = this.chains.get(mint);
    if (known) await Promise.all(known.map((m) => this.venue(m, maxAgeMs).catch(() => null)));
    const first = await this.venue(mint, maxAgeMs);
    if (!first.venue) return { route: null, idle: first.idle };
    const chain: PumpVenue[] = [first.venue];
    while (chain.length < MAX_HOPS) {
      const quote = (chain[chain.length - 1] as PumpVenue).quote.mint;
      if (quote === WSOL_MINT || STABLE_MINTS.has(quote) || this.notPump.has(quote)) break;
      const next = await this.venue(quote, maxAgeMs);
      if (!next.venue) {
        // The coin it is paired with exists but cannot trade right now (mid-migration).
        if (next.idle) return { route: null, idle: next.idle };
        break;
      }
      chain.push(next.venue);
    }
    bounded(this.chains).set(
      mint,
      chain.map((v) => v.mint),
    );
    const route = pickRoute(chain);
    return route ? { route, idle: routeIdle(route) } : { route: null, idle: null };
  }

  /**
   * Every way `mint` trades now: its pump.fun route while it has one that trades, else its
   * pools on the other programs Nesty knows (in one pay currency, the most liquid pool's).
   */
  async market(mint: SolAddress, maxAgeMs = VENUE_TTL_MS): Promise<MarketResult> {
    let pumpIdle: string | null = null;
    if (!this.notPump.has(mint)) {
      const { route, idle } = await this.route(mint, maxAgeMs);
      if (route && !idle)
        return this.withFunding({ routes: [pumpRoute(route)], idle: null }, maxAgeMs);
      pumpIdle = idle;
    }
    const dex = await this.dexMarket(mint, maxAgeMs);
    return dex.routes.length > 0
      ? this.withFunding(dex, maxAgeMs)
      : { routes: [], idle: pumpIdle ?? dex.idle };
  }

  /** A market priced in a token, with that token's pools against SOL when it has any. */
  private async withFunding(m: MarketResult, maxAgeMs: number): Promise<MarketResult> {
    const pay = m.routes[0] && routePay(m.routes[0]);
    if (!pay || isSolQuote(pay)) return m;
    const legs = await this.fundingLegs(pay, Math.max(maxAgeMs, LEG_AGE_MS)).catch(() => []);
    return legs.length > 0 ? { ...m, funding: legs } : m;
  }

  /**
   * The pools that turn SOL into `pay` and back, the best first: the index's pools of it
   * against wrapped SOL and Orca's fixed-fee ones, each read and checked on chain. None when
   * pools cannot trade it.
   */
  async fundingLegs(pay: QuoteAsset, maxAgeMs = VENUE_TTL_MS): Promise<DexVenue[]> {
    const hit = this.legs.get(pay.mint);
    if (hit && this.d.now() - hit.at <= maxAgeMs) return hit.legs;
    let load = this.legLoads.get(pay.mint);
    if (!load) {
      load = this.loadLegs(pay.mint)
        .then((legs) => {
          bounded(this.legs).set(pay.mint, { at: this.d.now(), legs });
          return legs;
        })
        .finally(() => this.legLoads.delete(pay.mint));
      this.legLoads.set(pay.mint, load);
    }
    return load;
  }

  private async loadLegs(mint: SolAddress): Promise<DexVenue[]> {
    const meta = await this.tokenMeta(mint);
    if (!meta || untradable(meta)) return [];
    const rpc = await this.rpc();
    const ctx: DexLoadCtx = {
      read: batchedReader(rpc),
      coinProgram: meta.tokenProgram,
      // These pools are only how SOL becomes the token: SOL is the one quote they may have.
      quoteAsset: async (m) => (m === WSOL_MINT ? SOL_QUOTE : null),
    };
    const ranked = this.legPools.get(mint);
    if (ranked && this.d.now() - ranked.at < ranked.ttl)
      return this.openPools(ctx, ranked.pools, mint);

    const gs = await this.d.settings.get();
    const fetchJson = gs.usePoolIndex ? this.d.fetchJson : undefined;
    const indexed = fetchJson
      ? await indexedPools(fetchJson, mint, MAX_DEX_POOLS, (m) => m === WSOL_MINT).catch(() => null)
      : [];
    const pools = [
      ...new Set([...(indexed ?? []).map((p) => p.pool), ...whirlpoolAddresses(mint, WSOL_MINT)]),
    ];
    // Ranked by what each pays for a SOL, so later reads load only the best few.
    const best = (await this.openPools(ctx, pools, mint))
      .map((v) => ({ v, out: dexModule(v).quote(v, 'buy', LEG_RANK_LAMPORTS) }))
      .filter((x) => x.out > 0n)
      .sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))
      .slice(0, MAX_FUNDING_LEGS)
      .map((x) => x.v);
    bounded(this.legPools).set(mint, {
      at: this.d.now(),
      ttl: indexed ? POOLS_TTL_MS : POOLS_RETRY_MS,
      pools: best.map((v) => v.pool),
    });
    return best;
  }

  /** The pools at `pools` that trade `mint` now, read in one batch. */
  private async openPools(
    ctx: DexLoadCtx,
    pools: readonly SolAddress[],
    mint: SolAddress,
  ): Promise<DexVenue[]> {
    const modules = await this.poolModules(pools, ctx.read);
    const venues = await Promise.all(
      pools.map((pool, i) => modules[i]?.load(ctx, pool, mint).catch(() => null) ?? null),
    );
    const nowSec = this.d.now() / 1000;
    return venues.filter((v): v is DexVenue => v !== null && dexModule(v).idle(v, nowSec) === null);
  }

  private async dexMarket(mint: SolAddress, maxAgeMs: number): Promise<MarketResult> {
    const hit = this.markets.get(mint);
    if (hit && this.d.now() - hit.at <= maxAgeMs) return hit.result;
    let load = this.marketLoads.get(mint);
    if (!load) {
      load = this.loadDexMarket(mint)
        .then((result) => {
          bounded(this.markets).set(mint, { at: this.d.now(), result });
          return result;
        })
        .finally(() => this.marketLoads.delete(mint));
      this.marketLoads.set(mint, load);
    }
    return load;
  }

  private async loadDexMarket(mint: SolAddress): Promise<MarketResult> {
    const none: MarketResult = { routes: [], idle: null };
    const [meta, pools] = await Promise.all([this.tokenMeta(mint), this.dexCandidates(mint)]);
    if (!meta || pools.length === 0) return none;
    if (untradable(meta))
      return { routes: [], idle: 'Tokens with a transfer fee or hook cannot be traded here yet.' };
    const ctx = await this.dexCtx(meta);
    const modules = await this.poolModules(pools, ctx.read);
    const venues = (
      await Promise.all(
        pools.map((pool, i) => modules[i]?.load(ctx, pool, mint).catch(() => null) ?? null),
      )
    ).filter((v): v is DexVenue => v !== null);
    const nowSec = this.d.now() / 1000;
    const open = venues.filter((v) => dexModule(v).idle(v, nowSec) === null);
    const first = open[0];
    if (!first) {
      const closed = venues[0];
      return closed ? { routes: [], idle: dexModule(closed).idle(closed, nowSec) } : none;
    }
    // One pay currency, the most liquid pool's: a buy is priced, and paid, in it.
    return { routes: open.filter((v) => v.quote.mint === first.quote.mint), idle: null };
  }

  /** What reading a coin's pools needs: one batched reader, and its pay currencies. */
  private async dexCtx(meta: SolTokenMeta): Promise<DexLoadCtx> {
    const rpc = await this.rpc();
    return {
      read: batchedReader(rpc),
      coinProgram: meta.tokenProgram,
      quoteAsset: async (m) => (isDexQuote(m) ? this.quoteAsset(rpc, m) : null),
    };
  }

  /** One pool of another program, read from chain now: null unless it trades `mint` now. */
  async venueAt(mint: SolAddress, pool: SolAddress): Promise<DexVenue | null> {
    const meta = await this.tokenMeta(mint);
    if (!meta || untradable(meta)) return null;
    const ctx = await this.dexCtx(meta);
    const [m] = await this.poolModules([pool], ctx.read);
    const v = m ? await m.load(ctx, pool, mint).catch(() => null) : null;
    return v && dexModule(v).idle(v, this.d.now() / 1000) === null ? v : null;
  }

  /**
   * A trade the Nesty website built, checked before the extension signs it as the
   * panel's own trades are: its route read again from chain, the user's limits, the
   * validator on the exact instructions, and a minimum received of at least half what the
   * route pays for it now (the site's slippage may be the user's; no site may set none).
   */
  async checkSiteTrade(
    wallet: SolAddress,
    ixs: readonly Instruction[],
    intent: SolTradeIntent,
  ): Promise<SiteTradeCheck> {
    const refuse = (reason: string): SiteTradeCheck => ({ ok: false, reason });
    const [gs, meta] = await Promise.all([this.d.settings.get(), this.tokenMeta(intent.mint)]);
    if (!meta) return refuse('Could not read this token.');
    let route: SolRoute | null = null;
    if (intent.route.kind === 'pump') {
      const r = await this.route(intent.mint, SITE_ROUTE_AGE_MS);
      if (r.route && !r.idle) route = pumpRoute(r.route);
    } else {
      route = await this.venueAt(intent.mint, intent.route.pool);
    }
    if (!route) return refuse('This token does not trade there right now.');
    const payAsset = routePay(route);
    const [pay, solUsd, legs] = await Promise.all([
      this.payInfo(route, gs.usePoolIndex),
      this.price.usd(),
      intent.side === 'buy' && !isSolQuote(payAsset)
        ? this.fundingLegs(payAsset).catch(() => [])
        : Promise.resolve([]),
    ]);
    // A buy paid in a token that comes from SOL is held to the limit by what the token is
    // worth in SOL, as the panel's own such buys are (the SOL step before it is a buy too).
    const funded = legs.length > 0;
    const limits = this.limits(gs, pay, solUsd);
    const verdict = validateTrade(ixs, {
      wallet,
      mint: intent.mint,
      route,
      side: intent.side,
      maxSpend: funded ? U64_MAX : limits.maxSpend,
      maxPriorityLamports: limits.maxPriorityLamports,
      payUnit: { symbol: pay.symbol, decimals: pay.decimals },
    });
    if (!verdict.ok) return refuseActions(verdict.actions);
    const quoted =
      intent.side === 'buy'
        ? buyQuote(route, verdict.amountIn)
        : sellQuote(route, verdict.amountIn);
    if (quoted === 0n) return refuse(noFill(route) ?? 'This trade cannot fill right now.');
    if (verdict.minOut * 2n < quoted)
      return refuse('Its minimum received is under half of what this trade pays now.');
    let worth: bigint | null = null;
    if (funded) {
      worth = bestRoute(legs, 'sell', verdict.amountIn)?.out ?? null;
      if (worth === null) return refuse('Nesty could not price what this buy spends.');
      if (worth > this.limits(gs, solPay(solUsd), solUsd).maxSpend)
        return refuse('This buy is above your per-transaction limit.');
    }

    const label = await this.routeLabel(route);
    const payAmount = intent.side === 'buy' ? verdict.amountIn : quoted;
    const payText = `${formatUnits(payAmount, pay.decimals)} ${pay.symbol}`;
    const coinText = `${formatUnits(intent.side === 'buy' ? quoted : verdict.amountIn, meta.decimals)} ${meta.symbol}`;
    const sol = SOLANA.nativeCurrency;
    const worthText =
      worth === null ? '' : ` (about ${formatUnits(worth, sol.decimals)} ${sol.symbol})`;
    return {
      ok: true,
      summary:
        intent.side === 'buy'
          ? `Buy about ${coinText} for ${payText}${worthText} on ${label}`
          : `Sell ${coinText} for about ${payText} on ${label}`,
      usd:
        worth !== null
          ? solUsd === null
            ? null
            : (Number(worth) / 10 ** sol.decimals) * solUsd
          : pay.usd === null
            ? null
            : (Number(payAmount) / 10 ** pay.decimals) * pay.usd,
    };
  }

  /**
   * A new pump.fun coin the Nesty website built, checked as its trades are: built again
   * here from the intent and pump.fun's Global as read now, the user's limits, and a
   * minimum for the dev buy of at least half what the fresh curve pays for it.
   */
  async checkSiteCreate(
    wallet: SolAddress,
    ixs: readonly Instruction[],
    intent: SolCreateIntent,
  ): Promise<SiteTradeCheck> {
    const refuse = (reason: string): SiteTradeCheck => ({ ok: false, reason });
    const problem = createIntentProblem(intent);
    if (problem) return refuse(problem);
    const rpc = await this.rpc();
    const [gs, solUsd, [g, f]] = await Promise.all([
      this.d.settings.get(),
      this.price.usd(),
      rpc.getMultipleAccounts([PUMP_GLOBAL, PUMP_FEE_CONFIG]),
    ]);
    const global = g?.owner === PUMP_PROGRAM ? decodeGlobal(g.data) : null;
    const feeConfig = f ? decodeFeeConfig(f.data) : null;
    if (!global?.launch || !feeConfig) return refuse('Could not read pump.fun settings.');
    if (!global.launch.createV2Enabled) return refuse('pump.fun is not creating coins right now.');
    const devBuy = BigInt(intent.devBuy);
    const minOut = BigInt(intent.minOut);
    const route = freshRoute(intent.mint, wallet, global, global.launch, feeConfig);
    const limits = this.limits(gs, solPay(solUsd), solUsd);
    const verdict = validatePumpCreate(ixs, {
      wallet,
      coin: {
        mint: intent.mint,
        name: intent.name,
        symbol: intent.symbol,
        uri: intent.uri,
        devBuy,
        minOut,
      },
      route,
      maxSpend: limits.maxSpend,
      maxPriorityLamports: limits.maxPriorityLamports,
    });
    if (!verdict.ok) return refuseActions(verdict.actions);
    if (devBuy > 0n) {
      const quoted = devBuyQuote(route, devBuy);
      if (quoted === 0n) return refuse('This dev buy would buy the whole curve.');
      if (minOut * 2n < quoted)
        return refuse('Its minimum received is under half of what this buy takes now.');
    }
    const sol = SOLANA.nativeCurrency;
    return {
      ok: true,
      summary:
        devBuy > 0n
          ? `Create ${intent.symbol} on pump.fun and buy it for ${formatUnits(devBuy, sol.decimals)} ${sol.symbol}`
          : `Create ${intent.symbol} on pump.fun`,
      usd: solUsd === null ? null : (Number(devBuy) / 10 ** sol.decimals) * solUsd,
    };
  }

  /**
   * The pools to quote `mint` on: the index's, most liquid first, then the launch curves
   * derived from its address, then any a page named.
   */
  private async dexCandidates(mint: SolAddress): Promise<SolAddress[]> {
    const derived = DEX_MODULES.flatMap((m) => m.candidates?.(mint) ?? []);
    const page = this.pagePools.get(mint) ?? [];
    const hit = this.dexPools.get(mint);
    let listed = hit?.pools ?? [];
    if (!hit || this.d.now() - hit.at >= hit.ttl) {
      const gs = await this.d.settings.get();
      const fetchJson = gs.usePoolIndex ? this.d.fetchJson : undefined;
      if (fetchJson) {
        const found = await indexedPools(fetchJson, mint, MAX_DEX_POOLS).catch(() => null);
        if (found) listed = found.map((p) => p.pool);
        bounded(this.dexPools).set(mint, {
          at: this.d.now(),
          ttl: found ? POOLS_TTL_MS : POOLS_RETRY_MS,
          pools: listed,
        });
      } else {
        listed = [];
      }
    }
    return [...new Set([...listed, ...derived, ...page])];
  }

  /** The module of each pool, from the program owning it (read once per pool). */
  private async poolModules(
    pools: readonly SolAddress[],
    read: DexLoadCtx['read'],
  ): Promise<(DexModule<DexVenue> | undefined)[]> {
    const unknown = pools.filter((p) => !this.poolOwners.has(p));
    if (unknown.length > 0) {
      const accs = await read(unknown);
      if (this.poolOwners.size > MAX_CACHE * 5) this.poolOwners.clear();
      unknown.forEach((p, i) => this.poolOwners.set(p, accs[i]?.owner ?? null));
    }
    return pools.map((p) => {
      const owner = this.poolOwners.get(p);
      return owner ? moduleOf(owner) : undefined;
    });
  }

  /** What `route` pays with, and its USD price. */
  private async payInfo(route: SolRoute, usePoolIndex: boolean): Promise<PayInfo> {
    const asset = routePay(route);
    if (isSolQuote(asset)) return solPay(await this.price.usd());
    const meta = await this.tokenMeta(asset.mint);
    if (!meta) throw new TradeError('rpc', 'Could not read the token this coin is bought with.');
    const stable = STABLE_MINTS.has(asset.mint);
    const usd = stable ? 1 : await this.tokenUsd(asset.mint, usePoolIndex);
    return { asset, symbol: meta.symbol, decimals: meta.decimals, usd, stable };
  }

  /**
   * A pay token's USD price: from its own pump.fun route when it is a pump.fun coin, else
   * from the pool index while the user allows it. Null when neither knows it.
   */
  async tokenUsd(mint: SolAddress, usePoolIndex: boolean, depth = 0): Promise<number | null> {
    if (STABLE_MINTS.has(mint)) return 1;
    if (mint === WSOL_MINT) return this.price.usd();
    const hit = this.usdPrices.get(mint);
    if (hit && this.d.now() - hit.at < PRICE_TTL_MS) return hit.usd;
    let usd: number | null = null;
    const route =
      depth < MAX_HOPS && !this.notPump.has(mint)
        ? ((await this.route(mint, 10_000).catch(() => null))?.route ?? null)
        : null;
    if (route) {
      const [meta, payMeta] = await this.tokenMetas([mint, route.pay.mint]);
      const payUsd = await this.tokenUsd(route.pay.mint, usePoolIndex, depth + 1);
      if (meta && payMeta && payUsd !== null)
        usd = routeSpotPrice(route) * 10 ** (meta.decimals - payMeta.decimals) * payUsd;
    } else if (usePoolIndex) {
      usd = await this.indexPrice(mint).catch(() => null);
    }
    bounded(this.usdPrices).set(mint, { at: this.d.now(), usd });
    return usd;
  }

  /** The pool index's USD price of `mint`, from its main Solana pair. */
  private async indexPrice(mint: SolAddress): Promise<number | null> {
    if (!this.d.fetchJson) return null;
    const json = (await this.d.fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    )) as { pairs?: (FeedPair & { chainId?: string })[] } | null;
    const pairs = (json?.pairs ?? []).filter((p) => p.chainId === 'solana');
    return feedPairs(pairs, [mint], (address) => address).get(mint)?.priceUsd ?? null;
  }

  /**
   * "pump.fun", "PumpSwap", for a route through other coins "pump.fun via WIF", or the
   * pool's program ("Raydium AMM").
   */
  private async routeLabel(r: SolRoute): Promise<string> {
    if (r.kind !== 'pump') return dexModule(r).label(r);
    const route = r.pump;
    const coin = routeCoin(route);
    if (route.hops.length === 1) return venueLabel(coin);
    const metas = await this.tokenMetas(route.hops.slice(0, -1).map((v) => v.mint)).catch(() => []);
    return `${venueLabel(coin)} via ${metas.map((m) => m?.symbol ?? '?').join(' → ')}`;
  }

  private async loadVenue(mint: SolAddress): Promise<VenueResult> {
    const rpc = await this.rpc();
    const curveAddr = bondingCurveAddress(mint);
    const known = this.pools.get(mint);
    // A pool's address depends on the coin's quote, which only its curve tells: SOL until known.
    const poolAddr = canonicalPoolAddress(mint, (known?.quote ?? SOL_QUOTE).mint);
    const fresh = this.configs && this.d.now() - this.configs.at < CONFIG_TTL_MS;
    const accs = await rpc.getMultipleAccounts([
      mint,
      curveAddr,
      poolAddr,
      associatedTokenAddress(curveAddr, mint, TOKEN_PROGRAM),
      associatedTokenAddress(curveAddr, mint, TOKEN_2022_PROGRAM),
      ...(known ? [known.base, known.quoteVault] : []),
      ...(fresh ? [] : [PUMP_GLOBAL, PUMP_FEE_CONFIG, AMM_GLOBAL_CONFIG, AMM_FEE_CONFIG]),
    ]);
    const [mintAcc, curveAcc, poolAcc, ataSpl, ata2022] = accs;
    let at = 5;
    let vaultAccs = known ? [accs[at++] ?? null, accs[at++] ?? null] : null;
    if (!fresh) {
      const [g, pf, ag, af] = accs.slice(at, at + 4);
      const global = g?.owner === PUMP_PROGRAM ? decodeGlobal(g.data) : null;
      const pumpFees = pf ? decodeFeeConfig(pf.data) : null;
      const ammGlobal = ag?.owner === PUMP_AMM_PROGRAM ? decodeAmmGlobalConfig(ag.data) : null;
      const ammFees = af ? decodeFeeConfig(af.data) : null;
      if (!global || !pumpFees || !ammGlobal || !ammFees)
        throw new TradeError('rpc', 'Could not read pump.fun settings.');
      this.configs = { at: this.d.now(), global, pumpFees, ammGlobal, ammFees };
    }
    const cfg = this.configs as Configs;

    if (!mintAcc || !isTokenProgram(mintAcc.owner)) return { venue: null, idle: null };
    const mintInfo = decodeMint(mintAcc.data);
    if (!mintInfo?.initialized) return { venue: null, idle: null };
    const tokenProgram = mintAcc.owner;

    const curve = curveAcc?.owner === PUMP_PROGRAM ? decodeBondingCurve(curveAcc.data) : null;
    const quoteMint = curve ? curveQuoteMint(curve) : (known?.quote.mint ?? WSOL_MINT);
    const quote = await this.quoteAsset(rpc, quoteMint);
    if (!quote) return { venue: null, idle: null, pump: !!curve };
    if (curve && !curveIdle(curve)) {
      const ata = tokenProgram === TOKEN_PROGRAM ? ataSpl : ata2022;
      const venue: PumpVenue = {
        kind: 'curve',
        mint,
        tokenProgram,
        quote,
        curve,
        curveTokenBalance: (ata && decodeTokenAccount(ata.data)?.amount) ?? 0n,
        global: cfg.global,
        feeConfig: cfg.pumpFees,
        mintSupply: mintInfo.supply,
      };
      return { venue, idle: null, pump: true };
    }

    // Migrated (or migrating): the canonical pool in the curve's quote.
    const poolAt = canonicalPoolAddress(mint, quote.mint);
    const poolInfo = poolAt === poolAddr ? poolAcc : await rpc.getAccount(poolAt);
    const pool = poolInfo?.owner === PUMP_AMM_PROGRAM ? decodePool(poolInfo.data) : null;
    if (pool && pool.baseMint === mint && pool.quoteMint === quote.mint) {
      const keys: PoolKeys = {
        quote,
        base: pool.poolBaseTokenAccount,
        quoteVault: pool.poolQuoteTokenAccount,
      };
      if (!vaultAccs || known?.base !== keys.base || known.quoteVault !== keys.quoteVault) {
        bounded(this.pools).set(mint, keys);
        vaultAccs = await rpc.getMultipleAccounts([keys.base, keys.quoteVault]);
      }
      const base = vaultAccs[0] ? decodeTokenAccount(vaultAccs[0].data) : null;
      const quoteVault = vaultAccs[1] ? decodeTokenAccount(vaultAccs[1].data) : null;
      if (!base || !quoteVault) return { venue: null, idle: null, pump: true };
      const venue: PumpVenue = {
        kind: 'pool',
        mint,
        tokenProgram,
        quote,
        poolAddress: poolAt,
        pool,
        baseReserve: base.amount,
        quoteReserve: quoteVault.amount,
        globalConfig: cfg.ammGlobal,
        feeConfig: cfg.ammFees,
        mintSupply: mintInfo.supply,
      };
      return { venue, idle: null, pump: true };
    }
    if (curve) {
      return {
        venue: null,
        idle: 'The pump.fun curve is complete. Trading opens on PumpSwap once it migrates.',
        pump: true,
      };
    }
    // Neither a curve nor a pool: not a pump.fun coin.
    return { venue: null, idle: null, pump: false };
  }

  /** A quote mint with its token program, read once (it never changes). */
  private async quoteAsset(rpc: SolRpc, mint: SolAddress): Promise<QuoteAsset | null> {
    if (mint === WSOL_MINT) return SOL_QUOTE;
    const hit = this.quoteAssets.get(mint);
    if (hit) return hit;
    const program = this.metas.get(mint)?.tokenProgram ?? (await rpc.getAccount(mint))?.owner;
    if (!program || !isTokenProgram(program)) return null;
    const asset: QuoteAsset = { mint, program };
    bounded(this.quoteAssets).set(mint, asset);
    return asset;
  }

  /**
   * SOL and `mint` balances of each owner (its associated token account), and its balance
   * of `pay` when given.
   */
  async balances(
    owners: readonly SolAddress[],
    mint: SolAddress | null,
    tokenProgram: SolAddress | null,
    pay?: QuoteAsset,
  ): Promise<{ native: bigint; token: bigint; pay: bigint }[]> {
    if (owners.length === 0) return [];
    const atas =
      mint && tokenProgram ? owners.map((o) => associatedTokenAddress(o, mint, tokenProgram)) : [];
    const payAtas = pay ? owners.map((o) => associatedTokenAddress(o, pay.mint, pay.program)) : [];
    const accs = await (await this.rpc()).getMultipleAccounts([...owners, ...atas, ...payAtas]);
    const amount = (acc: AccountInfo | null | undefined) =>
      (acc && decodeTokenAccount(acc.data)?.amount) ?? 0n;
    return owners.map((_, i) => ({
      native: accs[i]?.lamports ?? 0n,
      token: atas.length ? amount(accs[owners.length + i]) : 0n,
      pay: payAtas.length ? amount(accs[owners.length + atas.length + i]) : 0n,
    }));
  }

  // ── wallets ───────────────────────────────────────────────────────────────

  /** Exit plans: what each of these wallets with a Solana address holds of `mint`. */
  async holdingsOf(
    mint: SolAddress,
    walletIds: readonly string[],
  ): Promise<{ held: { walletId: string; token: bigint }[]; symbol: string | null }> {
    const wallets = (await this.solWallets()).filter((a) => walletIds.includes(a.id));
    const meta = await this.tokenMeta(mint);
    if (!meta || wallets.length === 0) return { held: [], symbol: meta?.symbol ?? null };
    const balances = await this.balances(
      wallets.map((w) => w.solana),
      mint,
      meta.tokenProgram,
    );
    return {
      held: wallets.map((w, i) => ({ walletId: w.id, token: balances[i]?.token ?? 0n })),
      symbol: meta.symbol,
    };
  }

  /**
   * Exit plans: what selling `amount` of `mint` returns now, in what the coin is bought
   * with (SOL, or the token it can only be bought with: `unit`, as its cost is recorded);
   * or why it cannot be sold.
   */
  async sellValue(
    mint: SolAddress,
    amount: bigint,
  ): Promise<{ out: bigint; unit: SolAddress | null } | { why: string }> {
    const { routes, idle, funding } = await this.market(mint, EXIT_QUOTE_AGE_MS);
    if (idle) return { why: idle };
    if (funding) {
      const f = fundedBest(routes, funding, 'sell', amount);
      return f ? { out: f.out, unit: null } : { why: 'No route to sell right now.' };
    }
    const best = bestRoute(routes, 'sell', amount);
    if (!best) return { why: 'No route to sell right now.' };
    const pay = routePay(best.route);
    return { out: best.out, unit: isSolQuote(pay) ? null : pay.mint };
  }

  /** Internal: also used by SolTransferFlow. */
  async solWallets(): Promise<SolWallet[]> {
    return (await this.d.vault.listAccounts()).filter((a): a is SolWallet => !!a.solana);
  }

  /** The selected wallets that have a Solana address, else the default (or first) one. */
  private async selectedIds(gs: GlobalSettings, visible: readonly SolWallet[]): Promise<string[]> {
    const ids = gs.selectedWalletIds.filter((id) => visible.some((a) => a.id === id));
    if (ids.length > 0) return ids;
    const first = visible.find((a) => a.primary) ?? visible[0];
    return first ? [first.id] : [];
  }

  /** Internal: also used by SolTransferFlow. */
  async tradeWallets(ids: readonly string[]): Promise<SolWallet[]> {
    const all = await this.d.vault.listAccounts();
    const picked = [...new Set(ids)]
      .map((id) => all.find((a) => a.id === id))
      .filter((a): a is WalletAccount => !!a);
    if (picked.length === 0) throw new TradeError('not_found', 'No wallet selected.');
    const sol = picked.filter((a): a is SolWallet => !!a.solana);
    if (sol.length === 0)
      throw new TradeError('not_found', 'Wallets imported from an EVM key have no Solana address.');
    return sol;
  }

  // ── panel ─────────────────────────────────────────────────────────────────

  async panelState(mint: SolAddress): Promise<PanelState> {
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const base: PanelState = {
      locked: true,
      wallets: [],
      nativeUsd: null,
      chain: {
        quickBuyAmounts: ss.quickBuyAmounts,
        quickSellBps: ss.quickSellBps,
        slippageBps: ss.slippageBps,
        priority: ss.priority,
        // Solana's priority fee is set in SOL per transaction (Settings → Chains → Solana).
        priorityGwei: ss.priorityFeeSol,
        customPriorityGwei: ss.customPriorityFeeSol,
        priorityApplies: true,
        mev: {
          supported: false,
          enabled: false,
          configured: false,
          reason: 'Not offered on Solana.',
        },
        maxTaxBps: 10_000,
      },
      global: {
        hotkeysEnabled: gs.hotkeysEnabled,
        multiWalletMode: gs.multiWalletMode,
        groups: gs.walletGroups,
        confirmAboveUsd: gs.confirmAboveUsd,
        maxUsdPerTx: gs.maxUsdPerTx,
        maxUsdPerClick: gs.maxUsdPerClick,
        priceImpactWarnBps: gs.priceImpactWarnBps,
        priceImpactDangerBps: gs.priceImpactDangerBps,
        quoteRefreshMs: gs.quoteRefreshMs,
      },
    };
    if (!(await this.d.vault.isUnlocked())) return base;
    const accounts = (await this.solWallets()).filter((a) => !a.hidden);
    const selected = new Set(await this.selectedIds(gs, accounts));
    const [meta, market] = await Promise.all([
      this.tokenMeta(mint).catch(() => null),
      this.market(mint, 2_000).catch(() => null),
    ]);
    // A coin that can only be bought with a token shows balances, prices and amounts in that
    // token; one whose token comes from SOL is bought with SOL, as any other.
    const route = market?.routes[0];
    const pay =
      route && !market.funding && !isSolQuote(routePay(route))
        ? await this.payInfo(route, gs.usePoolIndex).catch(() => null)
        : null;
    const [balances, nativeUsd] = await Promise.all([
      this.balances(
        accounts.map((a) => a.solana),
        meta ? mint : null,
        meta?.tokenProgram ?? null,
        pay?.asset,
      ).catch(() => []),
      pay ? pay.usd : this.price.usd(),
    ]);
    // Costs count in what it is bought with now: SOL, or that token.
    const basis = costBasis(
      await this.d.history.list(),
      SOLANA_CHAIN_ID,
      mint,
      pay?.asset.mint ?? null,
    );
    return {
      ...base,
      locked: false,
      nativeUsd,
      ...(pay && {
        pay: payCurrency(pay),
        chain: { ...base.chain, quickBuyAmounts: usdAmounts(ss.quickBuyUsd, pay) },
      }),
      wallets: accounts.map((a, i) => {
        const b = basis.get(a.id);
        const bal = balances[i];
        return {
          id: a.id,
          name: a.name,
          address: a.solana,
          primary: a.primary,
          selected: selected.has(a.id),
          native: ((pay ? bal?.pay : bal?.native) ?? 0n).toString(),
          token: (bal?.token ?? 0n).toString(),
          ...(b &&
            b.tokens > 0n && {
              cost: { tokens: b.tokens.toString(), costWei: b.costWei.toString() },
            }),
        };
      }),
    };
  }

  async panelQuotes(req: {
    mint: SolAddress;
    buyAmounts: string[];
    sellBps: number[];
  }): Promise<QuoteSet> {
    void this.warm().catch(() => undefined);
    const [{ routes, idle, funding }, meta, gs] = await Promise.all([
      this.market(req.mint),
      this.tokenMeta(req.mint),
      this.d.settings.get(),
    ]);
    const empty: QuoteSet = {
      buys: req.buyAmounts.map(() => null),
      sells: req.sellBps.map(() => null),
      tokenUsd: null,
      venue: null,
      idle,
      tax: null,
      taxUnknown: false,
      fetchedAt: this.d.now(),
    };
    const route = routes[0];
    if (!route || !meta) return empty;
    const [pay, labels, solUsd] = await Promise.all([
      this.payInfo(route, gs.usePoolIndex),
      Promise.all(routes.map((r) => this.routeLabel(r))),
      funding ? this.price.usd() : null,
    ]);
    // With pools of its pay token against SOL, amounts are in SOL; else in that token.
    const spend = funding ? solPay(solUsd) : pay;
    const labelOf = (r: SolRoute) => {
      const label = labels[routes.indexOf(r)] ?? '';
      return funding ? viaLabel(label, pay.symbol) : label;
    };
    // Each amount on the pool that pays most for it (through the SOL pool that pays most).
    const best = (side: Side, amount: bigint) =>
      funding ? fundedBest(routes, funding, side, amount) : bestRoute(routes, side, amount);

    const buyIn = req.buyAmounts.map((a) => {
      try {
        return parseUnits(a, spend.decimals);
      } catch {
        return 0n;
      }
    });
    const smallest = buyIn.reduce((m, a) => (a > 0n && (m === 0n || a < m) ? a : m), 0n);
    // A thousandth of a unit when no amount is set (0.001 SOL, $0.001 of USDC).
    const buyRef = (smallest || 10n ** BigInt(Math.max(0, spend.decimals - 3))) / 100n || 1n;
    const buyRefOut = best('buy', buyRef)?.out ?? 0n;

    let held = 0n;
    if (req.sellBps.length > 0 && (await this.d.vault.isUnlocked())) {
      const wallets = await this.solWallets();
      const ids = new Set(await this.selectedIds(gs, wallets));
      const owners = wallets.filter((a) => ids.has(a.id)).map((a) => a.solana);
      held = (await this.balances(owners, req.mint, meta.tokenProgram)).reduce(
        (s, b) => s + b.token,
        0n,
      );
    }
    const sellIn = held > 0n ? req.sellBps.map((bps) => (held * BigInt(bps)) / 10_000n) : [];
    const smallestSell = sellIn.reduce((m, a) => (a > 0n && (m === 0n || a < m) ? a : m), 0n);
    const sellRef = smallestSell / 100n || 1n;
    const sellRefOut = sellIn.length ? (best('sell', sellRef)?.out ?? 0n) : 0n;

    const view = (
      amountIn: bigint,
      q: { route: SolRoute; out: bigint } | null,
      refIn: bigint,
      refOut: bigint,
    ) =>
      q
        ? ({
            amountIn: amountIn.toString(),
            amountOut: q.out.toString(),
            priceImpactBps: refOut > 0n ? priceImpactBps(amountIn, q.out, refIn, refOut) : null,
            venue: labelOf(q.route),
          } satisfies QuoteView)
        : null;

    const price = spotPrice(route);
    // The pay token's price; else, bought through SOL, what its best pool against SOL says.
    const leg = funding?.[0];
    const payUsd =
      pay.usd ??
      (leg && solUsd !== null
        ? spotPrice(leg) * 10 ** (pay.decimals - spend.decimals) * solUsd
        : null);
    return {
      ...empty,
      buys: buyIn.map((a) => (a > 0n ? view(a, best('buy', a), buyRef, buyRefOut) : null)),
      sells: req.sellBps.map((_, i) => {
        const a = sellIn[i];
        return a ? view(a, best('sell', a), sellRef, sellRefOut) : null;
      }),
      tokenUsd:
        payUsd !== null && price > 0 ? price * 10 ** (meta.decimals - pay.decimals) * payUsd : null,
      venue: labelOf(route),
      idle: idle ?? (spend.usd === null ? noPrice(spend.symbol) : null),
    };
  }

  // ── tickets ───────────────────────────────────────────────────────────────

  /** Internal: also used by SolTransferFlow. */
  newTicket(
    kind: TradeTicket['kind'],
    legs: TicketLeg[],
    tabId?: number,
    mint?: SolAddress,
    meta?: SolTokenMeta | null,
  ): SolTicket {
    const now = this.d.now();
    for (const [id, st] of this.tickets) {
      const open = st.ticket.legs.some((l) =>
        ['queued', 'sending', 'submitted'].includes(l.status),
      );
      if (!open && now - st.ticket.createdAt > TICKET_TTL_MS) this.tickets.delete(id);
    }
    const ticket: TradeTicket = {
      id: crypto.randomUUID(),
      kind,
      chainId: SOLANA_CHAIN_ID,
      ...(mint ? { mint } : {}),
      status: 'working',
      legs,
      createdAt: now,
      explorer: SOLANA.explorer.url,
      ...(meta ? { symbol: meta.symbol, decimals: meta.decimals } : {}),
    };
    const st: SolTicket = { ticket, tabId, startedAt: now };
    this.tickets.set(ticket.id, st);
    return st;
  }

  /** Internal: also used by SolTransferFlow. */
  update(st: SolTicket): void {
    const legs = st.ticket.legs;
    const done = legs.filter((l) => l.status === 'confirmed').length;
    const bad = legs.filter((l) => ['failed', 'blocked', 'skipped'].includes(l.status)).length;
    if (done + bad === legs.length) {
      st.ticket.status =
        done === legs.length
          ? 'done'
          : done === 0
            ? st.ticket.blocked
              ? 'blocked'
              : 'failed'
            : 'partial';
    }
    const b = st.ticket.bridge;
    if (b && st.ticket.status === 'done') {
      // The deposit landed; the bridge is done once Relay paid out.
      if (b.relayStatus === 'failure' || b.relayStatus === 'refund') st.ticket.status = 'failed';
      else if (b.relayStatus !== 'success') st.ticket.status = 'working';
    }
    this.d.notify(structuredClone(st.ticket), st.tabId);
  }

  private clickTime(clickedAt: number | undefined): number {
    const now = this.d.now();
    return clickedAt !== undefined && clickedAt <= now && now - clickedAt < 30_000
      ? clickedAt
      : now;
  }

  private settingsSnapshot(ss: SolanaSettings): TicketSettings {
    return {
      slippageBps: ss.slippageBps,
      prioritySol: { level: ss.priority, sol: solanaPriorityFee(ss) },
    };
  }

  // ── trading ───────────────────────────────────────────────────────────────

  async buy(
    req: {
      mint: SolAddress;
      amount: string;
      walletIds: string[];
      mode: 'each' | 'split';
      confirmed: boolean;
      clickedAt?: number | undefined;
    },
    tabId?: number,
  ): Promise<TradeTicket> {
    const startedAt = this.clickTime(req.clickedAt);
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const wallets = await this.tradeWallets(req.walletIds);
    // The panel refreshes quotes about every second, so this is normally a cache hit.
    const { routes, idle, funding } = await this.market(
      req.mint,
      Math.min(gs.maxQuoteAgeMs, 2_000),
    );
    const primary = routes[0];
    if (!primary) throw new TradeError('no_route', idle ?? undefined);
    if (idle) throw new TradeError('no_route', idle);
    // The amount is in what the coin is bought with: SOL (through its quote token, when that
    // has pools against SOL), or else its quote token.
    const [pay, solUsd] = await Promise.all([
      this.payInfo(primary, gs.usePoolIndex),
      this.price.usd(),
    ]);
    const spend = funding ? solPay(solUsd) : pay;
    const total = parseUnits(req.amount, spend.decimals);
    const per = req.mode === 'split' ? total / BigInt(wallets.length) : total;
    if (per <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');
    const clickTotal = per * BigInt(wallets.length);

    if (spend.usd === null) throw new TradeError('limit_exceeded', noPrice(spend.symbol));
    const usdOf = (raw: bigint) => (Number(raw) / 10 ** spend.decimals) * (spend.usd as number);
    const perUsd = usdOf(per);
    const totalUsd = usdOf(clickTotal);
    if (perUsd > gs.maxUsdPerTx)
      throw new TradeError(
        'limit_exceeded',
        `$${perUsd.toFixed(2)} per wallet > $${gs.maxUsdPerTx}.`,
      );
    if (totalUsd > gs.maxUsdPerClick)
      throw new TradeError(
        'limit_exceeded',
        `$${totalUsd.toFixed(2)} total > $${gs.maxUsdPerClick}.`,
      );
    if (totalUsd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `$${totalUsd.toFixed(2)}`);

    // The wallets buy one after another from the same curve or pool: price the whole click
    // (on the pool that pays most for it), and give each wallet its share as its minimum.
    const best = funding
      ? fundedBest(routes, funding, 'buy', clickTotal)
      : bestRoute(routes, 'buy', clickTotal);
    if (!best) throw new TradeError('no_route', noFill(primary));
    const { route, out: totalOut } = best;
    const build = tradeBuilder(route);
    if (!build) throw new TradeError('no_route', 'pump.fun changed its fee accounts.');
    const meta = await this.tokenMeta(req.mint);
    if (!meta) throw new TradeError('no_route');

    const amounts = walletAmounts(per, wallets.length, gs.buyVarianceBps);
    const legs: TicketLeg[] = wallets.map((w, i) => ({
      walletId: w.id,
      walletName: w.name,
      kind: 'swap',
      status: 'queued',
      amountIn: (amounts[i] ?? per).toString(),
    }));
    // Through its token: each wallet's SOL becomes that first, in a step of its own.
    if (funding)
      wallets.forEach((w, i) =>
        legs.push({
          walletId: w.id,
          walletName: w.name,
          kind: 'step',
          note: `${spend.symbol} → ${pay.symbol}`,
          status: 'queued',
          amountIn: (amounts[i] ?? per).toString(),
        }),
      );
    const st = this.newTicket('buy', legs, tabId, req.mint, meta);
    st.startedAt = startedAt;
    const label = await this.routeLabel(route);
    st.ticket.route = funding ? viaLabel(label, pay.symbol) : label;
    st.ticket.settings = this.settingsSnapshot(ss);
    st.ticket.nativeUsd = spend.usd;
    if (!isSolQuote(spend.asset)) st.ticket.pay = payCurrency(spend);
    const limits = this.limits(gs, spend, solUsd);

    void (async () => {
      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i] as SolWallet;
        if (i > 0 && gs.jitterMaxMs > 0) await sleep(Math.floor(Math.random() * gs.jitterMaxMs));
        const amount = amounts[i] ?? per;
        if (funding) {
          const p = { wallet: w, mint: req.mint, pay, sol: spend, amount, gs, ss, ...limits };
          void this.fundedBuy(st, i, wallets.length + i, p);
          continue;
        }
        const minOut = minAfter((totalOut * amount) / clickTotal, ss.slippageBps);
        const trade = build('buy', w.solana, amount, minOut);
        void this.trade(st, i, {
          wallet: w,
          mint: req.mint,
          side: 'buy',
          route,
          amount,
          pay,
          instructions: trade.instructions,
          spend: trade.spend,
          gs,
          ss,
          ...limits,
        });
      }
    })();
    this.update(st);
    return structuredClone(st.ticket);
  }

  async sell(
    req: {
      mint: SolAddress;
      bps: number;
      walletIds: string[];
      confirmed: boolean;
      clickedAt?: number | undefined;
    },
    tabId?: number,
  ): Promise<TradeTicket> {
    const startedAt = this.clickTime(req.clickedAt);
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const wallets = await this.tradeWallets(req.walletIds);
    const meta = await this.tokenMeta(req.mint);
    if (!meta) throw new TradeError('no_route');
    const balances = await this.balances(
      wallets.map((w) => w.solana),
      req.mint,
      meta.tokenProgram,
    );
    const amounts = balances.map((b) => (b.token * BigInt(req.bps)) / 10_000n);
    const totalIn = amounts.reduce((a, b) => a + b, 0n);
    if (totalIn === 0n) throw new TradeError('insufficient_funds', 'No tokens to sell.');

    const { routes, idle, funding } = await this.market(
      req.mint,
      Math.min(gs.maxQuoteAgeMs, 2_000),
    );
    if (routes.length === 0) throw new TradeError('no_route', idle ?? undefined);
    if (idle) throw new TradeError('no_route', idle);
    // Through its token, when that has pools against SOL: the coin's own sell, then the token
    // it paid back to SOL.
    const funded = funding ? fundedBest(routes, funding, 'sell', totalIn) : null;
    const best = funded
      ? { route: funded.route, out: funded.mid }
      : bestRoute(routes, 'sell', totalIn);
    if (!best || (funding && !funded)) throw new TradeError('no_route');
    const { route } = best;
    const [pay, solUsd] = await Promise.all([
      this.payInfo(route, gs.usePoolIndex),
      this.price.usd(),
    ]);
    const into = funding ? solPay(solUsd) : pay;
    const totalOut = funded?.out ?? best.out;
    const outUsd = into.usd !== null ? (Number(totalOut) / 10 ** into.decimals) * into.usd : null;
    // Sells return funds to the user, so only the confirmation threshold applies.
    if (outUsd !== null && outUsd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `$${outUsd.toFixed(2)}`);
    const build = tradeBuilder(route);
    if (!build) throw new TradeError('no_route', 'pump.fun changed its fee accounts.');

    const legs: TicketLeg[] = wallets.map((w, i) => ({
      walletId: w.id,
      walletName: w.name,
      kind: 'swap',
      status: amounts[i] === 0n ? 'skipped' : 'queued',
      amountIn: (amounts[i] ?? 0n).toString(),
      ...(amounts[i] === 0n ? { error: 'No balance' } : {}),
    }));
    // Each selling wallet's step back to SOL, by the index of its own sell.
    const steps = new Map<number, number>();
    if (funding)
      wallets.forEach((w, i) => {
        if (!amounts[i]) return;
        steps.set(i, legs.length);
        legs.push({
          walletId: w.id,
          walletName: w.name,
          kind: 'step',
          note: `${pay.symbol} → ${into.symbol}`,
          status: 'queued',
        });
      });
    const st = this.newTicket('sell', legs, tabId, req.mint, meta);
    st.startedAt = startedAt;
    const label = await this.routeLabel(route);
    st.ticket.route = funding ? viaLabel(label, pay.symbol) : label;
    st.ticket.settings = this.settingsSnapshot(ss);
    if (into.usd !== null) st.ticket.nativeUsd = into.usd;
    if (!isSolQuote(into.asset)) st.ticket.pay = payCurrency(into);
    const limits = this.limits(gs, pay, solUsd);

    void (async () => {
      for (let i = 0; i < wallets.length; i++) {
        const amount = amounts[i] ?? 0n;
        if (amount === 0n) continue;
        if (i > 0 && gs.jitterMaxMs > 0) await sleep(Math.floor(Math.random() * gs.jitterMaxMs));
        const w = wallets[i] as SolWallet;
        const minOut = minAfter((best.out * amount) / totalIn, ss.slippageBps);
        const trade = build('sell', w.solana, amount, minOut);
        const step = steps.get(i);
        void this.trade(st, i, {
          wallet: w,
          mint: req.mint,
          side: 'sell',
          route,
          amount,
          pay,
          instructions: trade.instructions,
          spend: 0n,
          gs,
          ss,
          ...limits,
          // The token it pays is sold on for SOL; that SOL is what the sell got.
          ...(step !== undefined && {
            record: false,
            settled: (tx: TxMeta | null) => {
              const got = tx ? tokenDelta(tx, w.solana, pay.asset.mint) : null;
              const p = { wallet: w, pay, sol: into, gs, ss, ...limits };
              void this.unfund(st, i, step, p, got);
            },
          }),
        });
      }
    })();
    this.update(st);
    return structuredClone(st.ticket);
  }

  /**
   * The USD limits: per transaction in the pay currency, the network fee in lamports.
   * Without a price, nothing may be spent.
   */
  limits(
    gs: GlobalSettings,
    pay: Pick<PayInfo, 'usd' | 'decimals'>,
    solUsd: number | null,
  ): { maxSpend: bigint; maxPriorityLamports: bigint } {
    const raw = (usd: number, price: number | null, decimals: number) => {
      const units = price ? Math.floor((usd / price) * 10 ** decimals) : 0;
      return Number.isFinite(units) && units > 0 ? BigInt(units) : 0n;
    };
    return {
      maxSpend: raw(gs.maxUsdPerTx, pay.usd, pay.decimals),
      maxPriorityLamports: raw(gs.maxGasUsd, solUsd, SOLANA.nativeCurrency.decimals),
    };
  }

  /** One wallet's buy or sell. */
  private trade(
    st: SolTicket,
    i: number,
    p: {
      wallet: SolWallet;
      /** The coin the user asked to trade: the route must end in it. */
      mint: SolAddress;
      side: Side;
      route: SolRoute;
      /** What the side spends: the pay currency for a buy, the coin for a sell. */
      amount: bigint;
      pay: PayInfo;
      instructions: Instruction[];
      spend: bigint;
      gs: GlobalSettings;
      ss: SolanaSettings;
      maxSpend: bigint;
      maxPriorityLamports: bigint;
      /** Runs once it settles (see SolLegJob.settled). */
      settled?: (meta: TxMeta | null) => void;
      /** False when what it delivers is not what the ticket shows: a funded sell's token. */
      record?: boolean;
    },
  ): Promise<void> {
    const ctx = {
      wallet: p.wallet.solana,
      mint: p.mint,
      route: p.route,
      side: p.side,
      maxSpend: p.maxSpend,
      maxPriorityLamports: p.maxPriorityLamports,
      payUnit: { symbol: p.pay.symbol, decimals: p.pay.decimals },
    };
    return this.runLeg(st, i, {
      wallet: p.wallet,
      instructions: p.instructions,
      units: tradeUnits(p.route, p.side, p.amount),
      validate: (ixs) => validateTrade(ixs, ctx),
      intent: {
        kind: 'trade',
        mint: p.mint,
        side: p.side,
        route: p.route.kind === 'pump' ? { kind: 'pump' } : { kind: 'dex', pool: p.route.pool },
      },
      ...(p.side === 'buy'
        ? {
            shortfall: (rpc: SolRpc, fee: bigint) =>
              this.buyShortfall(rpc, p.wallet.solana, p.pay, p.spend, fee),
          }
        : {}),
      ...(p.record !== false && {
        delivered: (meta: TxMeta) =>
          tradeDelivered(meta, p.wallet.solana, p.side, p.mint, p.pay.asset),
      }),
      ...(p.settled && { settled: p.settled }),
      gs: p.gs,
      ss: p.ss,
    });
  }

  /**
   * One wallet's buy, with SOL, of a coin priced in a token: SOL into the token first, then
   * (once that has landed, so the exact amount is known) the coin with exactly that. Each is
   * its own transaction, as funded EVM curves are bought.
   */
  private async fundedBuy(
    st: SolTicket,
    i: number,
    stepAt: number,
    p: {
      wallet: SolWallet;
      mint: SolAddress;
      /** The token the coin is priced in, and SOL. */
      pay: PayInfo;
      sol: PayInfo;
      /** Lamports. */
      amount: bigint;
      gs: GlobalSettings;
      ss: SolanaSettings;
      maxSpend: bigint;
      maxPriorityLamports: bigint;
    },
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const step = st.ticket.legs[stepAt] as TicketLeg;
    const sym = p.pay.symbol;
    const fail = (error: string, status: LegStatus = 'failed') => {
      leg.status = status;
      leg.error = error;
      this.update(st);
    };

    // 1) SOL into the token, on its pool that pays most for it now.
    const legs = await this.fundingLegs(p.pay.asset).catch(() => []);
    const into = bestRoute(legs, 'buy', p.amount);
    const toToken = into && tradeBuilder(into.route);
    if (!into || !toToken) {
      step.status = 'failed';
      step.error = `No ${sym} quote`;
      return fail(`Could not get ${sym}`);
    }
    const swap = toToken(
      'buy',
      p.wallet.solana,
      p.amount,
      minAfter(into.out, FUNDING_SLIPPAGE_BPS),
    );
    const got = await new Promise<bigint | null>((resolve) => {
      void this.trade(st, stepAt, {
        wallet: p.wallet,
        mint: p.pay.asset.mint,
        side: 'buy',
        route: into.route,
        amount: p.amount,
        pay: p.sol,
        instructions: swap.instructions,
        // The coin's buy after it pays its network fee in SOL too.
        spend: swap.spend + priorityLamports(p.ss),
        gs: p.gs,
        ss: p.ss,
        maxSpend: p.maxSpend,
        maxPriorityLamports: p.maxPriorityLamports,
        settled: (tx) => resolve(tx ? tokenDelta(tx, p.wallet.solana, p.pay.asset.mint) : null),
      });
    });
    if (!got || got <= 0n) {
      // What stopped the step stops the buy: a wallet short of SOL is skipped, as any buy is.
      if (step.status === 'skipped' || step.status === 'blocked')
        return fail(step.error ?? `Could not get ${sym}`, step.status);
      return fail(
        step.status === 'confirmed'
          ? `Could not read the ${sym} that arrived: it stays in the wallet.`
          : step.status === 'submitted'
            ? `The ${sym} swap has not confirmed, so nothing was bought with it.`
            : (step.error ?? `Could not get ${sym}`),
      );
    }

    // 2) The coin, with exactly what arrived, on the route that pays most for it now.
    const { routes } = await this.market(p.mint).catch(() => ({ routes: [] as SolRoute[] }));
    const priced = routes.filter((r) => routePay(r).mint === p.pay.asset.mint);
    const coin = bestRoute(priced, 'buy', got);
    const buy = coin && tradeBuilder(coin.route);
    if (!coin || !buy)
      return fail(`No route for this coin right now: the ${sym} stays in the wallet.`);
    const trade = buy('buy', p.wallet.solana, got, minAfter(coin.out, p.ss.slippageBps));
    await this.trade(st, i, {
      wallet: p.wallet,
      mint: p.mint,
      side: 'buy',
      route: coin.route,
      amount: got,
      pay: p.pay,
      instructions: trade.instructions,
      spend: trade.spend,
      gs: p.gs,
      ss: p.ss,
      // The SOL step was held to the limit; this spends exactly what that step bought.
      maxSpend: got,
      maxPriorityLamports: p.maxPriorityLamports,
    });
  }

  /**
   * After one wallet's sell of a coin priced in a token: exactly the token it paid, back to
   * SOL on the token's pool that pays most for it, as a step of the same ticket.
   */
  private async unfund(
    st: SolTicket,
    i: number,
    stepAt: number,
    p: {
      wallet: SolWallet;
      pay: PayInfo;
      sol: PayInfo;
      gs: GlobalSettings;
      ss: SolanaSettings;
      maxPriorityLamports: bigint;
    },
    got: bigint | null,
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const step = st.ticket.legs[stepAt] as TicketLeg;
    const sym = p.pay.symbol;
    const stop = (error: string, status: LegStatus) => {
      step.status = status;
      step.error = error;
      this.update(st);
    };
    if (leg.status === 'submitted')
      return stop(`Not confirmed yet: any ${sym} it pays stays in the wallet.`, 'skipped');
    if (leg.status !== 'confirmed') return stop('The sell did not go through.', 'skipped');
    if (!got || got <= 0n)
      return stop(`Could not read the ${sym} it paid: that stays in the wallet.`, 'failed');
    step.amountIn = got.toString();
    const legs = await this.fundingLegs(p.pay.asset).catch(() => []);
    const back = bestRoute(legs, 'sell', got);
    const toSol = back && tradeBuilder(back.route);
    if (!back || !toSol)
      return stop(`No route from ${sym} to SOL right now: it stays in the wallet.`, 'failed');
    const swap = toSol('sell', p.wallet.solana, got, minAfter(back.out, FUNDING_SLIPPAGE_BPS));
    await this.trade(st, stepAt, {
      wallet: p.wallet,
      mint: p.pay.asset.mint,
      side: 'sell',
      route: back.route,
      amount: got,
      pay: p.sol,
      instructions: swap.instructions,
      spend: 0n,
      gs: p.gs,
      ss: p.ss,
      maxSpend: 0n,
      maxPriorityLamports: p.maxPriorityLamports,
      settled: (tx) => {
        const out = tx
          ? tradeDelivered(tx, p.wallet.solana, 'sell', p.pay.asset.mint, SOL_QUOTE)
          : 0n;
        if (out <= 0n) return;
        leg.amountOut = out.toString();
        this.update(st);
      },
    });
  }

  /**
   * Validate → (simulate) → sign → send → confirm, for one wallet's transaction. Nothing is
   * signed unless `job.validate` passes on the exact instructions. Internal: also runs
   * SolTransferFlow's transfers.
   */
  async runLeg(st: SolTicket, i: number, job: SolLegJob): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const tCheck = this.d.now();
    try {
      const rpc = this.rpcFor(job.ss);
      const fee = priorityLamports(job.ss);
      // A few random units make every transaction unique: an identical second click in the
      // same blockhash window would otherwise have the same signature and be dropped.
      let units = Math.min(MAX_COMPUTE_UNITS, job.units + Math.floor(Math.random() * 256));
      const withBudget = (u: number) => [
        setComputeUnitLimit(u),
        setComputeUnitPrice(microLamports(fee, u)),
        ...job.instructions,
      ];
      let ixs = withBudget(units);
      const verdict = job.validate(ixs);
      if (!verdict.ok) {
        leg.status = 'blocked';
        leg.error = verdict.actions.find((a) => !a.ok)?.reason ?? 'Blocked';
        st.ticket.blocked = verdict.actions;
        this.update(st);
        job.settled?.(null);
        return;
      }

      const [bh, short] = await Promise.all([
        this.blockhash(rpc),
        job.shortfall ? job.shortfall(rpc, fee) : null,
      ]);
      if (short) {
        leg.status = 'skipped';
        leg.error = short;
        this.update(st);
        job.settled?.(null);
        return;
      }

      if (job.gs.simulateBeforeSign) {
        const draft = serializeTransaction(
          compileMessage(job.wallet.solana, ixs, bh.blockhash),
          [],
        );
        const sim = await rpc.simulate(draft);
        if (sim.err) {
          leg.status = 'failed';
          leg.error = explainError(sim.err, ixs);
          this.update(st);
          job.settled?.(null);
          return;
        }
        if (sim.unitsConsumed) {
          units = Math.min(
            MAX_COMPUTE_UNITS,
            Math.max(30_000, Math.ceil(sim.unitsConsumed * 1.2)) + Math.floor(Math.random() * 256),
          );
          ixs = withBudget(units);
          // Same instructions, new budget: checked again all the same.
          if (!job.validate(ixs).ok) throw new Error('Blocked after simulation');
        }
      }

      const tSign = this.d.now();
      const message = compileMessage(job.wallet.solana, ixs, bh.blockhash);
      const signature = this.d.sign
        ? await this.d.sign({
            wallet: job.wallet,
            instructions: ixs,
            blockhash: bh.blockhash,
            message: message.bytes,
            intent: job.intent ?? null,
          })
        : await this.vaultSign(job.wallet, message.bytes);
      const raw = serializeTransaction(message, [signature]);
      const sig = base58.encode(signature);
      leg.status = 'sending';
      leg.sig = sig;
      const tSend = this.d.now();
      await rpc.broadcast(raw);
      const tDone = this.d.now();
      leg.status = 'submitted';
      leg.sentMs = Math.max(0, tDone - st.startedAt);
      leg.phases = {
        prepMs: Math.max(0, tCheck - st.startedAt),
        checkMs: tSign - tCheck,
        signMs: tSend - tSign,
        sendMs: tDone - tSend,
      };
      this.update(st);
      void this.confirm(st, i, { rpc, raw, sig, ixs, lastValid: bh.lastValidBlockHeight, job });
    } catch (e) {
      leg.status = 'failed';
      leg.error = e instanceof AggregateError ? shortErr(e.errors[0]) : shortErr(e);
      markRefused(st.ticket, leg, e);
      this.update(st);
      job.settled?.(null);
    }
  }

  private async vaultSign(wallet: SolWallet, message: Uint8Array): Promise<Uint8Array> {
    const secret = await this.d.vault.solanaKeyFor(wallet.id);
    try {
      // The key must be the fee payer's: anything else would be a vault fault.
      if (publicKeyOf(secret) !== wallet.solana) throw new Error('Key mismatch');
      return signMessage(message, secret);
    } finally {
      secret.fill(0);
    }
  }

  /** Why `wallet` cannot fund a buy of `spend` in the pay currency, or null when it can. */
  private async buyShortfall(
    rpc: SolRpc,
    wallet: SolAddress,
    pay: PayInfo,
    spend: bigint,
    fee: bigint,
  ): Promise<string | null> {
    const sol = (lamports: bigint) => formatUnits(lamports, SOLANA.nativeCurrency.decimals);
    if (isSolQuote(pay.asset)) {
      const need = spend + fee + BUY_HEADROOM;
      return (await rpc.getBalance(wallet)) < need
        ? `Insufficient SOL: about ${sol(need)} needed.`
        : null;
    }
    const [solAcc, payAcc] = await rpc.getMultipleAccounts([
      wallet,
      associatedTokenAddress(wallet, pay.asset.mint, pay.asset.program),
    ]);
    if (((payAcc && decodeTokenAccount(payAcc.data)?.amount) ?? 0n) < spend)
      return `Insufficient ${pay.symbol}: ${formatUnits(spend, pay.decimals)} needed.`;
    // The network fee and any new account's rent are still paid in SOL.
    const need = fee + BUY_HEADROOM;
    return (solAcc?.lamports ?? 0n) < need
      ? `Insufficient SOL for fees: about ${sol(need)} needed.`
      : null;
  }

  /** Waits for the transaction, re-sending it until it lands or its blockhash expires. */
  private async confirm(
    st: SolTicket,
    i: number,
    p: {
      rpc: SolRpc;
      raw: Uint8Array;
      sig: string;
      ixs: Instruction[];
      lastValid: number;
      job: SolLegJob;
    },
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const sentAt = this.d.now();
    let lastSend = sentAt;
    let heightAt = sentAt;
    while (this.d.now() - sentAt < CONFIRM_TIMEOUT_MS) {
      await sleep(CONFIRM_POLL_MS);
      const status = (await p.rpc.getSignatureStatuses([p.sig]).catch(() => [null]))[0] ?? null;
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        leg.confirmMs = Math.max(0, this.d.now() - sentAt);
        if (status.err) {
          leg.status = 'failed';
          leg.error = explainError(status.err, p.ixs);
        } else leg.status = 'confirmed';
        this.update(st);
        if (leg.status === 'confirmed') p.job.onConfirmed?.();
        void this.fill(st, i, p.rpc, p.sig, p.job);
        return;
      }
      const now = this.d.now();
      if (now - lastSend >= REBROADCAST_MS) {
        lastSend = now;
        void p.rpc.broadcast(p.raw).catch(() => undefined);
      }
      if (now - heightAt >= 4_000) {
        heightAt = now;
        const height = await p.rpc.getBlockHeight().catch(() => null);
        if (height !== null && height > p.lastValid && !status) {
          leg.status = 'failed';
          leg.error = 'Expired before it landed. Try a higher priority fee.';
          this.update(st);
          p.job.settled?.(null);
          return;
        }
      }
    }
    leg.error = 'Not confirmed yet. Check the explorer.';
    this.update(st);
    p.job.settled?.(null);
  }

  /** The fee the transaction paid, and what it delivered. Best effort. */
  private async fill(
    st: SolTicket,
    i: number,
    rpc: SolRpc,
    sig: string,
    job: SolLegJob,
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    let landed: TxMeta | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const meta = await rpc.getTransactionMeta(sig).catch(() => null);
      if (meta) {
        leg.feeWei = meta.fee.toString();
        if (leg.status === 'confirmed') {
          landed = meta;
          const out = job.delivered?.(meta) ?? 0n;
          if (out > 0n) leg.amountOut = out.toString();
        }
        this.update(st);
        break;
      }
      await sleep(1_000);
    }
    job.settled?.(landed);
  }

  // ── portfolio ─────────────────────────────────────────────────────────────

  /** Every token account of each wallet (an indexed read only a private RPC answers). */
  private async scanHoldings(rpc: SolRpc, wallets: readonly SolWallet[]): Promise<Holdings> {
    const out: Holdings = new Map();
    for (const w of wallets) {
      for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
        for (const acc of await rpc.getTokenAccounts(w.solana, program)) {
          const t = decodeTokenAccount(acc.data);
          if (t && t.owner === w.solana) addHolding(out, t.mint, w.id, t.amount);
        }
      }
    }
    return out;
  }

  /** Each wallet's own token account of each known mint, read in batches. */
  private async knownHoldings(
    rpc: SolRpc,
    wallets: readonly SolWallet[],
    mints: readonly SolAddress[],
  ): Promise<Holdings> {
    const metas = await this.tokenMetas(mints);
    const reads = mints.flatMap((mint, i) => {
      const meta = metas[i];
      return meta
        ? wallets.map((w) => ({
            mint,
            wallet: w,
            account: associatedTokenAddress(w.solana, mint, meta.tokenProgram),
          }))
        : [];
    });
    const accs = await rpc.getMultipleAccounts(reads.map((r) => r.account));
    const out: Holdings = new Map();
    reads.forEach((r, i) => {
      const acc = accs[i];
      const t = acc ? decodeTokenAccount(acc.data) : null;
      if (t && t.mint === r.mint && t.owner === r.wallet.solana)
        addHolding(out, r.mint, r.wallet.id, t.amount);
    });
    return out;
  }

  /** SOL and token holdings of `walletIds`, valued at pump.fun prices where they trade. */
  async portfolio(walletIds: readonly string[]): Promise<Portfolio> {
    const all = await this.solWallets();
    const wallets = all.filter((a) => walletIds.includes(a.id));
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const rpc = this.rpcFor(ss);
    const [history, lists] = await Promise.all([this.d.history.list(), this.trustLists()]);
    const bought = new Set(
      history.filter((t) => t.chainId === SOLANA_CHAIN_ID && t.mint).map((t) => t.mint as string),
    );
    const trusted = new Set(lists.trusted);
    const hidden = new Set(lists.hidden);
    // Airdrops the user never bought or claimed: often scams with a faked price.
    const unsolicited = (mint: SolAddress) =>
      hidden.has(mint) || (!bought.has(mint) && !trusted.has(mint));
    // The tokens Nesty knows, newest first: traded, added by hand, or hidden.
    const known = [
      ...new Set([...[...lists.trusted].reverse(), ...bought, ...[...lists.hidden].reverse()]),
    ].slice(0, MAX_KNOWN);
    const [nativeUsd, natives, scanned] = await Promise.all([
      this.price.usd(),
      rpc.getMultipleAccounts(wallets.map((w) => w.solana)),
      // Only the user's own RPC lists every token account, so only it finds tokens sent in.
      ss.customRpc ? this.scanHoldings(rpc, wallets).catch(() => null) : null,
    ]);
    const perMint = scanned ?? (await this.knownHoldings(rpc, wallets, known));
    // With many holdings the user's own come first, so a fresh buy never falls off the list.
    const mints = [...perMint.keys()]
      .sort((a, b) => Number(unsolicited(a)) - Number(unsolicited(b)))
      .slice(0, MAX_TOKENS);
    const metas = await this.tokenMetas(mints).catch(() => mints.map(() => null));
    // A few at a time: public RPCs refuse bursts.
    const tokens = await mapLimit(mints, 4, async (mint, i): Promise<PortfolioTokenView | null> => {
      const meta = metas[i];
      if (!meta) return null;
      const row = perMint.get(mint) ?? {};
      const total = Object.values(row).reduce((s, v) => s + v, 0n);
      // Unsolicited tokens are not priced: their price can be faked, and it costs reads.
      let valueUsd: number | null = null;
      let costUnit: PortfolioTokenView['costUnit'];
      // What its costs count in: SOL, or the token it can only be bought with (unknown unpriced).
      let unit: SolAddress | null | undefined;
      if (!unsolicited(mint) && i < MAX_PRICED) {
        const market = await this.market(mint, 10_000).catch(() => null);
        const routes = market?.routes ?? [];
        const route = routes[0];
        const pay = route ? await this.payInfo(route, gs.usePoolIndex).catch(() => null) : null;
        if (pay?.usd != null)
          valueUsd =
            (Number(bestRoute(routes, 'sell', total)?.out ?? 0n) / 10 ** pay.decimals) * pay.usd;
        unit = null;
        // Bought with a token, with no way there from SOL: what it cost is in that token.
        if (pay && !market?.funding && !isSolQuote(pay.asset)) {
          costUnit = {
            usd: pay.usd,
            decimals: pay.decimals,
            symbol: pay.symbol,
            mint: pay.asset.mint,
          };
          unit = pay.asset.mint;
        }
      }
      const cost: Record<string, { tokens: string; costWei: string }> = {};
      for (const [id, b] of costBasis(history, SOLANA_CHAIN_ID, mint, unit)) {
        if (b.tokens > 0n)
          cost[id] = { tokens: b.tokens.toString(), costWei: b.costWei.toString() };
      }
      return {
        address: mint,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        perWallet: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.toString()])),
        total: total.toString(),
        valueUsd,
        dust: valueUsd === null || valueUsd < DUST_USD,
        unsolicited: unsolicited(mint),
        supply: meta.supply.toString(),
        ...(Object.keys(cost).length > 0 ? { cost, ...(costUnit && { costUnit }) } : {}),
      };
    });
    return {
      chainId: SOLANA_CHAIN_ID,
      nativeUsd,
      native: Object.fromEntries(
        wallets.map((w, i) => [w.id, (natives[i]?.lamports ?? 0n).toString()]),
      ),
      tokens: tokens
        .filter((t): t is PortfolioTokenView => t !== null)
        .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)),
    };
  }
}

/** Raw amounts per mint, per wallet id. */
type Holdings = Map<SolAddress, Record<string, bigint>>;

function addHolding(into: Holdings, mint: SolAddress, walletId: string, amount: bigint): void {
  if (amount === 0n) return;
  const row = into.get(mint) ?? {};
  row[walletId] = (row[walletId] ?? 0n) + amount;
  into.set(mint, row);
}

/** `fn` over `items`, at most `limit` running at once; results keep their order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** SOL as a pay currency, at `usd`. */
const solPay = (usd: number | null): PayInfo => ({
  asset: SOL_QUOTE,
  symbol: SOLANA.nativeCurrency.symbol,
  decimals: SOLANA.nativeCurrency.decimals,
  usd,
  stable: false,
});

/** A route's label for a trade through SOL and its pay token: "PumpSwap via AAPLx". */
const viaLabel = (label: string, symbol: string) =>
  `${label}${label.includes(' via ') ? ' →' : ' via'} ${symbol}`;

const payCurrency = (p: PayInfo): PayCurrency => ({
  mint: p.asset.mint,
  symbol: p.symbol,
  decimals: p.decimals,
  stable: p.stable,
});

const noPrice = (symbol: string) =>
  `No USD price for ${symbol}, so buys cannot be checked against your limits.`;

/** `x` to `sig` significant digits, as a plain decimal with at most `maxDecimals`. */
function roundSig(x: number, sig: number, maxDecimals: number): string {
  if (!(x > 0) || !Number.isFinite(x)) return '0';
  const decimals = sig - 1 - Math.floor(Math.log10(x));
  if (decimals <= 0) {
    const step = 10 ** -decimals;
    return String(Math.round(x / step) * step);
  }
  const s = x.toFixed(Math.min(decimals, maxDecimals, 20));
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * The USD quick-buy amounts in a pay token: as they are for a dollar stablecoin, else at
 * its price, rounded to as few digits as keep them apart. None without a price (buys are
 * refused then).
 */
function usdAmounts(usd: readonly string[], pay: PayInfo): string[] {
  if (pay.stable) return [...usd];
  const price = pay.usd;
  if (!price) return [];
  for (let sig = 2; sig <= 6; sig++) {
    const out = usd.map((u) => roundSig(Number(u) / price, sig, pay.decimals));
    const plain = out.every((a) => /^\d+(\.\d+)?$/.test(a) && Number(a) > 0);
    if (plain && new Set(out).size === out.length) return out;
  }
  return [];
}

/** `amount` less `bps` of slippage, never zero (a zero minimum would accept anything). */
function minAfter(amount: bigint, bps: number): bigint {
  const min = (amount * BigInt(10_000 - bps)) / 10_000n;
  return min > 0n ? min : 1n;
}

/** The priority fee each transaction pays, in lamports. */
const priorityLamports = (ss: SolanaSettings): bigint =>
  parseUnits(solanaPriorityFee(ss), SOLANA.nativeCurrency.decimals);

/** Per-unit price that makes `units` of compute cost `feeLamports` in total. */
function microLamports(feeLamports: bigint, units: number): bigint {
  return (feeLamports * 1_000_000n) / BigInt(units);
}

function parseMeta(mintAcc: AccountInfo | null, metaAcc: AccountInfo | null): SolTokenMeta | null {
  if (!mintAcc || !isTokenProgram(mintAcc.owner)) return null;
  const info = decodeMint(mintAcc.data);
  if (!info?.initialized) return null;
  const mp = metaAcc?.owner === METADATA_PROGRAM ? decodeMetaplexMetadata(metaAcc.data) : null;
  const uri = info.uri || mp?.uri;
  return {
    name: sanitizeLabel(info.name || mp?.name || '', 32) || 'Unknown token',
    symbol: sanitizeLabel(info.symbol || mp?.symbol || '', 16) || '???',
    decimals: info.decimals,
    tokenProgram: mintAcc.owner,
    supply: info.supply,
    ...(info.extensions.length > 0 ? { extensions: info.extensions } : {}),
    ...(info.transferHookProgram ? { hookProgram: info.transferHookProgram } : {}),
    ...(uri ? { uri } : {}),
  };
}
