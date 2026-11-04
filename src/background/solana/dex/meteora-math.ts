/**
 * Arithmetic Meteora's DAMM v2 and Dynamic Bonding Curve programs share (MeteoraAg/damm-v2,
 * MeteoraAg/dynamic-bonding-curve): Q64.64 square-root prices over concentrated liquidity,
 * fee numerators over 1e9, the decaying fee schedules, the volatility fee and the rate
 * limiter. Each rounding and each refusal follows the programs, so a quote is what they pay.
 */
import { refuse } from './refusal';

export const FEE_DENOMINATOR = 1_000_000_000n;
export const ONE_Q64 = 1n << 64n;
export const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BPS = 10_000n;

export const fitU64 = (x: bigint): bigint => (x >= 0n && x <= U64_MAX ? x : refuse());
const fitU128 = (x: bigint): bigint => (x >= 0n && x <= U128_MAX ? x : refuse());
const divUp = (a: bigint, b: bigint): bigint => (b === 0n ? refuse() : (a + b - 1n) / b);

/** The fee a numerator takes from an amount, rounded up. */
export const feeOn = (amount: bigint, numerator: bigint): bigint =>
  fitU64(divUp(amount * numerator, FEE_DENOMINATOR));

/** Base token over a price move: L·(√upper − √lower) / (√upper·√lower). */
export function deltaBase(lower: bigint, upper: bigint, liquidity: bigint, up: boolean): bigint {
  const den = lower * upper;
  if (den === 0n || upper < lower) refuse();
  const prod = liquidity * (upper - lower);
  return up ? divUp(prod, den) : prod / den;
}

/** Quote token over a price move: L·(√upper − √lower), in Q128. */
export function deltaQuote(lower: bigint, upper: bigint, liquidity: bigint, up: boolean): bigint {
  if (upper < lower) refuse();
  const prod = liquidity * (upper - lower);
  return up ? divUp(prod, 1n << 128n) : prod >> 128n;
}

/** The price after `amountIn` of the base (price falls) or the quote (price rises). */
export function nextSqrtFromInput(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
  baseIn: boolean,
): bigint {
  if (sqrtPrice === 0n || liquidity === 0n) refuse();
  if (amountIn === 0n) return sqrtPrice;
  if (baseIn) return fitU128(divUp(liquidity * sqrtPrice, liquidity + amountIn * sqrtPrice));
  return fitU128(sqrtPrice + (amountIn << 128n) / liquidity);
}

/** base^exp in Q64.64, multiplying bit by bit as the programs do (truncating each step). */
function powQ64(base: bigint, exp: bigint): bigint {
  if (exp === 0n) return ONE_Q64;
  if (exp >= 0x80000n) refuse();
  const mul = (a: bigint, b: bigint) => fitU128(a * b) >> 64n;
  let sq = base;
  let result = ONE_Q64;
  let invert = false;
  if (sq >= result) {
    sq = U128_MAX / sq;
    invert = true;
  }
  if (exp & 1n) result = mul(result, sq);
  for (let bit = 1n; bit < 19n; bit++) {
    sq = mul(sq, sq);
    if (exp & (1n << bit)) result = mul(result, sq);
  }
  if (result === 0n) refuse();
  return invert ? U128_MAX / result : result;
}

/**
 * cliff·(1 − reduction/10⁴)^period. DAMM v2 returns the cliff outright for a zero
 * reduction; the bonding curve program computes it anyway.
 */
export function feeInPeriod(
  cliff: bigint,
  reduction: bigint,
  period: bigint,
  zeroIsCliff: boolean,
): bigint {
  if (zeroIsCliff && reduction === 0n) return cliff;
  const bps = (reduction << 64n) / BPS;
  if (bps > ONE_Q64) refuse();
  return fitU64(fitU128(powQ64(ONE_Q64 - bps, period) * cliff) >> 64n);
}

/** A fee schedule's numerator after `period` periods (linear or exponential). */
export function scheduledFee(
  exponential: boolean,
  cliff: bigint,
  reduction: bigint,
  period: bigint,
  zeroIsCliff: boolean,
): bigint {
  if (exponential) return feeInPeriod(cliff, reduction, period, zeroIsCliff);
  const cut = reduction * period;
  return cut > cliff ? refuse() : cliff - cut;
}

/** A fee given in basis points, as a numerator over 1e9. */
export const bpsNumerator = (bps: bigint): bigint => fitU64((bps * FEE_DENOMINATOR) / BPS);

/**
 * The rate limiter's fee numerator for an input: the cliff up to the reference amount, then
 * one increment more for each further reference amount, up to `maxFee`.
 */
export function rateLimitedFee(
  input: bigint,
  cliff: bigint,
  reference: bigint,
  incrementBps: bigint,
  maxFee: bigint,
): bigint {
  if (input <= reference) return cliff;
  if (reference === 0n || maxFee < cliff) refuse();
  const i = bpsNumerator(incrementBps);
  if (i === 0n) refuse();
  const maxIndex = (maxFee - cliff) / i;
  const a = (input - reference) / reference;
  const b = (input - reference) % reference;
  const total =
    a < maxIndex
      ? reference * (cliff + cliff * a + (i * a * (a + 1n)) / 2n) + b * (cliff + i * (a + 1n))
      : reference * (cliff + cliff * maxIndex + (i * maxIndex * (maxIndex + 1n)) / 2n) +
        ((a - maxIndex) * reference + b) * maxFee;
  const fee = fitU64(divUp(total, FEE_DENOMINATOR));
  return fitU64(divUp(fee * FEE_DENOMINATOR, input));
}

/** The volatility fee: (accumulator·bin step)²·control / 1e11, rounded up. */
export function volatilityFee(accumulator: bigint, binStep: bigint, control: bigint): bigint {
  const square = fitU128((accumulator * binStep) ** 2n);
  return fitU128(fitU128(square * control) + 99_999_999_999n) / 100_000_000_000n;
}
