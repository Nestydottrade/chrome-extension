/**
 * Orca Whirlpool's fixed-point arithmetic (orca-so/whirlpools): Q64.64 square-root prices
 * from tick indexes and back, token amounts over a price move, and one exact-input swap
 * step. Each rounding and each failure follows the program, so a quote is what it pays.
 */
import { refuse } from './refusal';

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515401279992447579055n;
export const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const Q64_MASK = U64_MAX;
/** Fee rates are in millionths. */
const FEE_RATE_MUL = 1_000_000n;

const POSITIVE: readonly bigint[] = [
  79236085330515764027303304731n,
  79244008939048815603706035061n,
  79259858533276714757314932305n,
  79291567232598584799939703904n,
  79355022692464371645785046466n,
  79482085999252804386437311141n,
  79736823300114093921829183326n,
  80248749790819932309965073892n,
  81282483887344747381513967011n,
  83390072131320151908154831281n,
  87770609709833776024991924138n,
  97234110755111693312479820773n,
  119332217159966728226237229890n,
  179736315981702064433883588727n,
  407748233172238350107850275304n,
  2098478828474011932436660412517n,
  55581415166113811149459800483533n,
  38992368544603139932233054999993551n,
];

const NEGATIVE: readonly bigint[] = [
  18444899583751176498n,
  18443055278223354162n,
  18439367220385604838n,
  18431993317065449817n,
  18417254355718160513n,
  18387811781193591352n,
  18329067761203520168n,
  18212142134806087854n,
  17980523815641551639n,
  17526086738831147013n,
  16651378430235024244n,
  15030750278693429944n,
  12247334978882834399n,
  8131365268884726200n,
  3584323654723342297n,
  696457651847595233n,
  26294789957452057n,
  37481735321082n,
];

/** The square-root price at a tick, in Q64.64. */
export function sqrtPriceFromTick(tick: number): bigint {
  if (tick >= 0) {
    let ratio = tick & 1 ? 79232123823359799118286999567n : 79228162514264337593543950336n;
    POSITIVE.forEach((k, i) => {
      if (tick & (2 << i)) ratio = (ratio * k) >> 96n;
    });
    return ratio >> 32n;
  }
  const abs = -tick;
  let ratio = abs & 1 ? 18445821805675392311n : 18446744073709551616n;
  NEGATIVE.forEach((k, i) => {
    if (abs & (2 << i)) ratio = (ratio * k) >> 64n;
  });
  return ratio;
}

const LOG_B_2_X32 = 59543866431248n;
const LOG_ERR_LOWER_X64 = 184467440737095516n;
const LOG_ERR_UPPER_X64 = 15793534762490258745n;

/** The tick a square-root price falls in (rounded down). */
export function tickFromSqrtPrice(sqrtPrice: bigint): number {
  const msb = sqrtPrice.toString(2).length - 1;
  const integer = BigInt(msb - 64) << 32n;
  let r = msb >= 64 ? sqrtPrice >> BigInt(msb - 63) : sqrtPrice << BigInt(63 - msb);
  let bit = 0x8000_0000_0000_0000n;
  let fraction = 0n;
  for (let precision = 0; bit > 0n && precision < 14; precision++) {
    r *= r;
    const more = r >> 127n;
    r >>= 63n + more;
    fraction += bit * more;
    bit >>= 1n;
  }
  const logB = (integer + (fraction >> 32n)) * LOG_B_2_X32;
  const low = Number((logB - LOG_ERR_LOWER_X64) >> 64n);
  const high = Number((logB + LOG_ERR_UPPER_X64) >> 64n);
  if (low === high) return low;
  return sqrtPriceFromTick(high) <= sqrtPrice ? high : low;
}

const ordered = (p0: bigint, p1: bigint): [bigint, bigint] => (p0 > p1 ? [p1, p0] : [p0, p1]);

/** Token A over a price move, or null past u64 (where the program reports it exceeds). */
function tryDeltaA(p0: bigint, p1: bigint, liquidity: bigint, up: boolean): bigint | null {
  const [lower, upper] = ordered(p0, p1);
  const product = liquidity * (upper - lower);
  if (product >> 192n) refuse();
  const numerator = product << 64n;
  const denominator = upper * lower;
  if (denominator === 0n) refuse();
  let q = numerator / denominator;
  if (up && numerator % denominator !== 0n) q += 1n;
  return q > U64_MAX ? null : q;
}

/** Token B over a price move, or null past u64. */
function tryDeltaB(p0: bigint, p1: bigint, liquidity: bigint, up: boolean): bigint | null {
  const [lower, upper] = ordered(p0, p1);
  const diff = upper - lower;
  if (liquidity === 0n || diff === 0n) return 0n;
  const p = liquidity * diff;
  if (p > U128_MAX) return null;
  const result = p >> 64n;
  const round = up && (p & Q64_MASK) > 0n;
  if (round && result === U64_MAX) return null;
  return round ? result + 1n : result;
}

const deltaA = (p0: bigint, p1: bigint, l: bigint, up: boolean) =>
  tryDeltaA(p0, p1, l, up) ?? refuse();
const deltaB = (p0: bigint, p1: bigint, l: bigint, up: boolean) =>
  tryDeltaB(p0, p1, l, up) ?? refuse();

/** The price after `amount` of token A goes in, rounded up. */
function nextSqrtFromA(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  const product = liquidity * sqrtPrice;
  if (product >> 192n) refuse();
  const numerator = product << 64n;
  const denominator = (liquidity << 64n) + sqrtPrice * amount;
  const q = numerator / denominator;
  const price = numerator % denominator !== 0n ? q + 1n : q;
  if (price > U128_MAX || price < MIN_SQRT_PRICE || price > MAX_SQRT_PRICE) refuse();
  return price;
}

/** The price after `amount` of token B goes in, rounded down. */
function nextSqrtFromB(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (liquidity === 0n) refuse();
  const price = sqrtPrice + (amount << 64n) / liquidity;
  return price > U128_MAX ? refuse() : price;
}

export interface SwapStep {
  amountIn: bigint;
  amountOut: bigint;
  nextPrice: bigint;
  fee: bigint;
}

/** One step of an exact-input swap toward `target` (`compute_swap`). */
export function computeSwapIn(
  remaining: bigint,
  feeRate: bigint,
  liquidity: bigint,
  current: bigint,
  target: bigint,
  aToB: boolean,
): SwapStep {
  const initial = aToB
    ? tryDeltaA(current, target, liquidity, true)
    : tryDeltaB(current, target, liquidity, true);
  const calc = (remaining * (FEE_RATE_MUL - feeRate)) / FEE_RATE_MUL;
  const nextPrice =
    initial !== null && initial <= calc
      ? target
      : aToB
        ? nextSqrtFromA(current, liquidity, calc)
        : nextSqrtFromB(current, liquidity, calc);
  const isMax = nextPrice === target;
  const amountOut = aToB
    ? deltaB(current, nextPrice, liquidity, false)
    : deltaA(current, nextPrice, liquidity, false);
  const amountIn =
    !isMax || initial === null
      ? aToB
        ? deltaA(current, nextPrice, liquidity, true)
        : deltaB(current, nextPrice, liquidity, true)
      : initial;
  let fee: bigint;
  if (!isMax) {
    fee = remaining - amountIn;
    if (fee < 0n) refuse();
  } else {
    const p = amountIn * feeRate;
    const d = FEE_RATE_MUL - feeRate;
    fee = p / d + (p % d > 0n ? 1n : 0n);
    if (fee > U64_MAX) refuse();
  }
  return { amountIn, amountOut, nextPrice, fee };
}

/** Floor division of tick arithmetic (the program's `floor_division`). */
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
