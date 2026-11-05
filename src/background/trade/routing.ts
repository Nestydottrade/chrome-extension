import type { Address } from 'viem';
import type { PoolRef, Side, Venue, VenueCtx } from './types';

export interface Routed {
  pool: PoolRef;
  venue: Venue;
  out: bigint;
}

const POOL_TTL_MS = 60_000;
/** How much more a fallback route must pay out to replace one of Nesty's own. */
const FALLBACK_EDGE_BPS = 50;
/** How long a refresh quotes only the pools that won the last full round. */
const FULL_ROUND_MS = 15_000;
/** Full rounds remembered at most (one per chain, token, side and amounts). */
const ROUNDS_KEPT = 256;

/** A pool's key across venues: two venues may list the same pool. */
const poolKey = (p: PoolRef): string => `${p.venueId}:${p.id}`;

/** A refresh's last full round: when, the pools that won an amount, and the amounts routed. */
interface FullRound {
  at: number;
  won: Set<string>;
  routed: boolean[];
}

/** Discovers pools across venues (cached) and picks the best pool per amount. */
/**
 * A route's output after its extra gas: on a buy the gas is native spent on top of
 * `amount` (so the tokens per native shrink), on a sell it comes out of the native received.
 */
function netOfGas(ctx: VenueCtx, r: Routed, side: Side, amount: bigint): bigint {
  const gas = r.venue.extraGasWei?.(ctx, r.pool, side, amount) ?? 0n;
  if (gas <= 0n) return r.out;
  if (side === 'sell') return r.out > gas ? r.out - gas : 0n;
  return amount > 0n ? (r.out * amount) / (amount + gas) : 0n;
}

export class Routing {
  private readonly pools = new Map<string, { at: number; pools: PoolRef[] }>();
  /** Last quote per (chain, token, side, amount), so a click can reuse the panel's prefetch. */
  private readonly recent = new Map<string, { at: number; route: Routed }>();
  /** Tokens whose fallback (aggregator) routes delivered less than quoted: until when. */
  private readonly distrusted = new Map<string, number>();
  /** Each refresh's last full round, by chain, token, side and amounts. */
  private readonly rounds = new Map<string, FullRound>();

  /**
   * `fallback` venues (aggregators) are quoted alongside and used when no regular pool can
   * trade an amount, or when they pay clearly more (DEXes Nesty does not list).
   */
  constructor(
    private readonly venues: readonly Venue[],
    private readonly fallback: readonly Venue[] = [],
  ) {}

  private quoteKey(chainId: number, token: Address, side: Side, amount: bigint): string {
    return `${chainId}:${token.toLowerCase()}:${side}:${amount}`;
  }

  /** A route quoted within `maxAgeMs`, or undefined. */
  cached(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    amount: bigint,
    maxAgeMs: number,
  ): Routed | undefined {
    const hit = this.recent.get(this.quoteKey(ctx.chain.id, token, side, amount));
    return hit && ctx.now() - hit.at <= maxAgeMs ? hit.route : undefined;
  }

  venue(id: string): Venue | undefined {
    return this.venues.find((v) => v.id === id) ?? this.fallback.find((v) => v.id === id);
  }

  /** Whether `venue` is a fallback (aggregator) whose quotes come from an outside API. */
  isFallback(venue: Venue): boolean {
    return this.fallback.includes(venue);
  }

  /**
   * Stops preferring fallback routes for `token` for `ms` (they are still used when no
   * pool of Nesty's own can trade it). Called when a simulated fill fell short of the
   * quote: the aggregator misjudged a pool on its route.
   */
  distrust(ctx: VenueCtx, token: Address, ms: number): void {
    this.distrusted.set(`${ctx.chain.id}:${token.toLowerCase()}`, ctx.now() + ms);
    for (const key of this.recent.keys()) {
      if (key.startsWith(`${ctx.chain.id}:${token.toLowerCase()}:`)) this.recent.delete(key);
    }
  }

  private isDistrusted(ctx: VenueCtx, token: Address): boolean {
    const until = this.distrusted.get(`${ctx.chain.id}:${token.toLowerCase()}`);
    return until !== undefined && ctx.now() < until;
  }

  /** Why no pool can trade `token` right now, when a venue knows; else null. */
  async whyNone(ctx: VenueCtx, token: Address): Promise<string | null> {
    const why = await Promise.all(
      this.venues
        .filter((v) => v.idle && v.supports(ctx.chain.id))
        .map((v) => v.idle?.(ctx, token).catch(() => null) ?? null),
    );
    return why.find((w) => w) ?? null;
  }

  async discover(ctx: VenueCtx, token: Address, fresh = false): Promise<PoolRef[]> {
    const key = `${ctx.chain.id}:${token.toLowerCase()}`;
    const hit = this.pools.get(key);
    if (!fresh && hit && ctx.now() - hit.at < POOL_TTL_MS) return hit.pools;
    const found = await Promise.all(
      this.venues
        .filter((v) => v.supports(ctx.chain.id))
        .map((v) => v.discover(ctx, token).catch(() => [])),
    );
    const pools = found.flat();
    this.pools.set(key, { at: ctx.now(), pools });
    return pools;
  }

  /**
   * For each amount, the pool with the highest output (null if no pool could quote it).
   * `own`: only Nesty's own pools, never a fallback (aggregator) route.
   */
  async best(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    amounts: readonly bigint[],
    opts: { own?: boolean } = {},
  ): Promise<(Routed | null)[]> {
    return (await this.bestWithRef(ctx, token, side, null, amounts, opts)).map((r) => r.route);
  }

  /**
   * Like best(), but also quotes a tiny reference amount on every pool in the same
   * round trip, so price impact can be computed against the chosen pool.
   *
   * `refresh`: the same amounts asked again, as the panel does every few seconds. Every pool
   * costs a quote per amount, and a token can have twenty pools. So for FULL_ROUND_MS after
   * a full round, only the pools that won it are quoted. A full round runs again once it is
   * due, when none of those pools is still listed, or when one lost a route it had.
   */
  async bestWithRef(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    ref: bigint | null,
    amounts: readonly bigint[],
    opts: { own?: boolean; refresh?: boolean } = {},
  ): Promise<{ route: Routed | null; refOut: bigint | null }[]> {
    const empty = amounts.map(() => ({ route: null, refOut: null }));
    if (amounts.length === 0) return empty;
    const chosen = await this.choose(ctx, token, side, ref, amounts, !!opts.own, !!opts.refresh);
    // Own-only answers are side lookups (tax, checks), not what the panel offers.
    if (opts.own) return chosen;
    const at = ctx.now();
    chosen.forEach((c, i) => {
      if (c.route)
        this.recent.set(this.quoteKey(ctx.chain.id, token, side, amounts[i] as bigint), {
          at,
          route: c.route,
        });
    });
    return chosen;
  }

  private async choose(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    ref: bigint | null,
    amounts: readonly bigint[],
    ownOnly: boolean,
    refresh: boolean,
  ): Promise<{ route: Routed | null; refOut: bigint | null }[]> {
    const pools = await this.discover(ctx, token);
    const found = refresh
      ? await this.pickAgain(ctx, token, side, ref, amounts, pools)
      : await this.pick(ctx, token, side, ref, amounts, pools);
    if (this.fallback.length === 0 || ownOnly) return found;
    const distrusted = this.isDistrusted(ctx, token);
    // Distrusted: only where none of Nesty's own pools can quote, skip the API call otherwise.
    if (distrusted && found.every((f) => f.route)) return found;
    const extra = (
      await Promise.all(
        this.fallback
          .filter((v) => v.supports(ctx.chain.id))
          .map((v) => v.discover(ctx, token).catch(() => [])),
      )
    ).flat();
    if (extra.length === 0) return found;
    // Aggregators can reach DEXes Nesty does not list: their route wins only when it pays
    // clearly more, since it costs an API round trip at click time.
    const more = await this.pick(ctx, token, side, ref, amounts, extra);
    return found.map((own, i) => {
      const alt = more[i];
      if (!alt?.route) return own;
      if (!own.route) return alt;
      if (distrusted) return own;
      const net = netOfGas(ctx, alt.route, side, amounts[i] as bigint);
      return net * 10_000n > own.route.out * BigInt(10_000 + FALLBACK_EDGE_BPS) ? alt : own;
    });
  }

  private async pick(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    ref: bigint | null,
    amounts: readonly bigint[],
    pools: PoolRef[],
  ): Promise<{ route: Routed | null; refOut: bigint | null }[]> {
    const empty = amounts.map(() => ({ route: null, refOut: null }));
    if (pools.length === 0 || amounts.length === 0) return empty;
    const all = ref !== null ? [ref, ...amounts] : [...amounts];
    const offset = ref !== null ? 1 : 0;
    const quotes = await Promise.all(
      pools.map(async (pool) => {
        const venue = this.venue(pool.venueId);
        if (!venue) return all.map(() => null);
        return venue.quote(ctx, pool, side, all).catch(() => all.map(() => null));
      }),
    );
    return amounts.map((amount, i) => {
      let route: Routed | null = null;
      let refOut: bigint | null = null;
      pools.forEach((pool, p) => {
        const out = quotes[p]?.[i + offset] ?? null;
        const venue = this.venue(pool.venueId);
        if (venue && out !== null && out > 0n && (!route || out > route.out)) {
          route = { pool, venue, out };
          refOut = ref !== null ? (quotes[p]?.[0] ?? null) : null;
        }
      });
      return { route, refOut };
    });
  }

  /** pick() for a refresh: the last full round's winners alone, while that round holds. */
  private async pickAgain(
    ctx: VenueCtx,
    token: Address,
    side: Side,
    ref: bigint | null,
    amounts: readonly bigint[],
    pools: PoolRef[],
  ): Promise<{ route: Routed | null; refOut: bigint | null }[]> {
    const key = `${ctx.chain.id}:${token.toLowerCase()}:${side}:${ref ?? ''}:${amounts.join(',')}`;
    const last = this.rounds.get(key);
    if (last && ctx.now() - last.at < FULL_ROUND_MS) {
      const winners = pools.filter((p) => last.won.has(poolKey(p)));
      if (winners.length > 0) {
        const again = await this.pick(ctx, token, side, ref, amounts, winners);
        if (again.every((r, i) => r.route !== null || !last.routed[i])) return again;
      }
    }
    const full = await this.pick(ctx, token, side, ref, amounts, pools);
    this.rounds.delete(key);
    if (this.rounds.size >= ROUNDS_KEPT) {
      const oldest = this.rounds.keys().next().value;
      if (oldest !== undefined) this.rounds.delete(oldest);
    }
    this.rounds.set(key, {
      at: ctx.now(),
      won: new Set(full.flatMap((r) => (r.route ? [poolKey(r.route.pool)] : []))),
      routed: full.map((r) => r.route !== null),
    });
    return full;
  }

  /** Quote a specific pool again (used right before sending). */
  async requote(ctx: VenueCtx, pool: PoolRef, side: Side, amount: bigint): Promise<bigint | null> {
    const venue = this.venue(pool.venueId);
    if (!venue) return null;
    const [out] = await venue.quote(ctx, pool, side, [amount]).catch(() => [null]);
    return out ?? null;
  }
}

/**
 * Price impact vs. a tiny reference trade on the same pool, in basis points.
 * impact = 1 - (out / in) / (refOut / refIn)
 */
export function priceImpactBps(
  amountIn: bigint,
  out: bigint,
  refIn: bigint,
  refOut: bigint,
): number | null {
  if (amountIn <= 0n || refIn <= 0n || refOut <= 0n) return null;
  const num = out * refIn * 10_000n;
  const den = amountIn * refOut;
  const ratioBps = Number(num / den);
  return Math.max(0, 10_000 - ratioBps);
}
