import type { SolAddress } from '../../shared/solana';
import { dexModule, type DexVenue } from './dex';
import {
  buyInstructions,
  isSolQuote,
  pickRecipients,
  routeBuyQuote,
  routeCoin,
  routeIdle,
  routeSellQuote,
  routeSpotPrice,
  routeVariant,
  sellInstructions,
  type PumpRoute,
  type QuoteAsset,
  type Side,
  type TradeIxs,
  type TradeVariant,
} from './pump';
import type { TxMeta } from './rpc';
import { closeAccount, createAtaIdempotent, syncNative, transfer, wsolAccount } from './spl';
import type { Instruction } from './tx';
import {
  validateDexTx,
  validateSolanaTx,
  type SolValidationContext,
  type SolValidationResult,
} from './validator';

/**
 * How a coin trades: through pump.fun (its curve, its PumpSwap pool, or a route of them),
 * or on one pool of another program.
 */
export type SolRoute = { kind: 'pump'; pump: PumpRoute } | DexVenue;

export const pumpRoute = (pump: PumpRoute): SolRoute => ({ kind: 'pump', pump });

/** What a route is bought with and sells into. */
export const routePay = (r: SolRoute): QuoteAsset => (r.kind === 'pump' ? r.pump.pay : r.quote);

/** The coin a route ends in, and its token program. */
export function routeToken(r: SolRoute): { mint: SolAddress; tokenProgram: SolAddress } {
  const v = r.kind === 'pump' ? routeCoin(r.pump) : r;
  return { mint: v.mint, tokenProgram: v.tokenProgram };
}

/** What `amountIn` of the pay currency buys of the coin. */
export const buyQuote = (r: SolRoute, amountIn: bigint): bigint =>
  r.kind === 'pump' ? routeBuyQuote(r.pump, amountIn) : dexModule(r).quote(r, 'buy', amountIn);

/** What selling `tokens` of the coin pays in the pay currency. */
export const sellQuote = (r: SolRoute, tokens: bigint): bigint =>
  r.kind === 'pump' ? routeSellQuote(r.pump, tokens) : dexModule(r).quote(r, 'sell', tokens);

/** Pay units per raw coin unit at the current price. */
export const spotPrice = (r: SolRoute): number =>
  r.kind === 'pump' ? routeSpotPrice(r.pump) : dexModule(r).spot(r);

/** Why the route cannot trade right now, or null. */
export const routeIdleAt = (r: SolRoute, nowSec: number): string | null =>
  r.kind === 'pump' ? routeIdle(r.pump) : dexModule(r).idle(r, nowSec);

/** The route that pays most for `amountIn` (a buy) or `tokens` (a sell), and what it pays. */
export function bestRoute<R extends SolRoute>(
  routes: readonly R[],
  side: Side,
  amountIn: bigint,
): { route: R; out: bigint } | null {
  let best: { route: R; out: bigint } | null = null;
  for (const route of routes) {
    const out = side === 'buy' ? buyQuote(route, amountIn) : sellQuote(route, amountIn);
    if (out > 0n && (!best || out > best.out)) best = { route, out };
  }
  return best;
}

/** A trade through SOL of a coin priced in a token: both its legs, and what each pays. */
export interface FundedQuote {
  route: SolRoute;
  /** The pool between SOL and the pay token. */
  leg: DexVenue;
  /** The pay token in between: what the leg buys (a buy), or what the coin sells for. */
  mid: bigint;
  /** Coins for a buy, lamports for a sell. */
  out: bigint;
}

/**
 * A buy of `amountIn` lamports: SOL into the pay token on the leg that pays most, then
 * that on the route that pays most. A sell of `amountIn` coins: the other way round.
 */
export function fundedBest(
  routes: readonly SolRoute[],
  legs: readonly DexVenue[],
  side: Side,
  amountIn: bigint,
): FundedQuote | null {
  if (side === 'buy') {
    const leg = bestRoute(legs, 'buy', amountIn);
    const coin = leg && bestRoute(routes, 'buy', leg.out);
    return leg && coin ? { route: coin.route, leg: leg.route, mid: leg.out, out: coin.out } : null;
  }
  const coin = bestRoute(routes, 'sell', amountIn);
  const leg = coin && bestRoute(legs, 'sell', coin.out);
  return coin && leg ? { route: coin.route, leg: leg.route, mid: coin.out, out: leg.out } : null;
}

/** Compute a pump.fun trade asks for when it is not simulated first (unused units are free). */
const PUMP_UNITS: Record<Exclude<TradeVariant, 'multi-hop'>, Record<Side, number>> = {
  'curve-v3': { buy: 220_000, sell: 160_000 },
  'curve-v2': { buy: 260_000, sell: 200_000 },
  'pool-v2': { buy: 300_000, sell: 240_000 },
  'pool-v1': { buy: 320_000, sell: 280_000 },
};
/** A pump.fun route: about 200k per hop, plus the accounts around it. */
const UNITS_PER_HOP = 200_000;

/** Compute a trade of `amount` (what `side` spends) asks for when it is not simulated first. */
export function tradeUnits(r: SolRoute, side: Side, amount: bigint): number {
  if (r.kind !== 'pump') {
    const m = dexModule(r);
    return m.unitsFor?.(r, side, amount) ?? m.units;
  }
  const variant = routeVariant(r.pump);
  return variant === 'multi-hop'
    ? UNITS_PER_HOP * r.pump.hops.length + 100_000
    : PUMP_UNITS[variant][side];
}

/**
 * One wallet's trade: `amount` of what `side` spends (the pay currency for a buy, the coin
 * for a sell), at least `minOut` back.
 */
export type TradeBuilder = (
  side: Side,
  user: SolAddress,
  amount: bigint,
  minOut: bigint,
) => TradeIxs;

/** Builds the trades of one click on `r`; null when pump.fun lists no fee accounts Nesty knows. */
export function tradeBuilder(r: SolRoute): TradeBuilder | null {
  if (r.kind !== 'pump')
    return (side, user, amount, minOut) => dexTrade(r, side, user, amount, minOut);
  const pump = r.pump;
  const rec = pickRecipients(pump);
  if (!rec) return null;
  return (side, user, amount, minOut) =>
    side === 'buy'
      ? buyInstructions(pump, user, amount, minOut, rec)
      : sellInstructions(pump, user, amount, minOut, rec);
}

function dexTrade(
  r: DexVenue,
  side: Side,
  user: SolAddress,
  amount: bigint,
  minOut: bigint,
): TradeIxs {
  const swap = dexModule(r).swap(r, side, user, amount, minOut);
  const openQuote = createAtaIdempotent(user, r.quote.mint, r.quote.program);
  // Pools trade wrapped SOL: it is wrapped for a buy, and unwrapped after either side.
  const sol = isSolQuote(r.quote);
  const wsol = wsolAccount(user);
  const unwrap: Instruction[] = sol ? [closeAccount(wsol, user)] : [];
  if (side === 'sell') return { spend: 0n, instructions: [openQuote, swap, ...unwrap] };
  return {
    spend: amount,
    instructions: [
      ...(sol ? [openQuote, transfer(user, wsol, amount), syncNative(wsol)] : []),
      createAtaIdempotent(user, r.mint, r.tokenProgram),
      swap,
      ...unwrap,
    ],
  };
}

/** The validator for a route's trades: every instruction must be one Nesty builds for it. */
export function validateTrade(
  ixs: readonly Instruction[],
  ctx: Omit<SolValidationContext, 'route'> & { route: SolRoute },
): SolValidationResult {
  const { route, ...rest } = ctx;
  return route.kind === 'pump'
    ? validateSolanaTx(ixs, { ...rest, route: route.pump })
    : validateDexTx(ixs, { ...rest, venue: route });
}

/** How much more of `mint` `owner` holds after the transaction than before. */
export function tokenDelta(meta: TxMeta, owner: SolAddress, mint: SolAddress): bigint {
  const held = (list: TxMeta['preTokenBalances']) =>
    list.filter((b) => b.mint === mint && b.owner === owner).reduce((sum, b) => sum + b.amount, 0n);
  return held(meta.postTokenBalances) - held(meta.preTokenBalances);
}

/** What a confirmed buy or sell delivered to `owner`: the coin, or what it was sold for. */
export function tradeDelivered(
  meta: TxMeta,
  owner: SolAddress,
  side: Side,
  mint: SolAddress,
  pay: QuoteAsset,
): bigint {
  if (side === 'buy') return tokenDelta(meta, owner, mint);
  if (!isSolQuote(pay)) return tokenDelta(meta, owner, pay.mint);
  const at = meta.accountKeys.indexOf(owner);
  if (at < 0) return 0n;
  // What left the wrapped SOL account counts once: closing it also returns what it held
  // before, and its rent.
  const wsolAt = meta.accountKeys.indexOf(wsolAccount(owner));
  const unwrapped =
    wsolAt >= 0 ? (meta.preBalances[wsolAt] ?? 0n) - (meta.postBalances[wsolAt] ?? 0n) : 0n;
  const delta = (meta.postBalances[at] ?? 0n) - (meta.preBalances[at] ?? 0n);
  return delta + meta.fee - unwrapped;
}

/** Why a buy is quoted nothing, when more can be said than that no route fills it. */
export function noFill(r: SolRoute): string | undefined {
  if (r.kind !== 'pump') return 'This pool cannot fill that amount. Try a smaller one.';
  const coin = routeCoin(r.pump);
  // Past a curve's end, where no migration fills the rest.
  return coin.kind === 'curve' && (routeVariant(r.pump) === 'curve-v2' || coin.curve.isMayhemMode)
    ? 'This buy is more than the curve has left. Try a smaller amount.'
    : undefined;
}
