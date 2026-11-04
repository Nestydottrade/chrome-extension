import type { SolAddress } from '../../../shared/solana';
import {
  SYSVAR_CLOCK,
  addressBytes,
  associatedTokenAddress,
  coinOfPair,
  findProgramAddress,
  seed,
} from '../address';
import { Reader, decodeClock, hasDiscriminator, type ChainClock } from '../layouts';
import type { Side } from '../pump';
import { concat, meta, u64, type Instruction } from '../tx';
import { quoteOrZero, refuse } from './refusal';
import type { DexModule, DexVenueBase } from './types';
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  U64_MAX,
  computeSwapIn,
  floorDiv,
  sqrtPriceFromTick,
  tickFromSqrtPrice,
} from './whirlpool-math';

/**
 * Orca's Whirlpools: concentrated liquidity over ticks, kept in arrays of 88 that a swap
 * walks three at a time. Facts from its source (orca-so/whirlpools): an exact-input swap
 * steps from initialized tick to initialized tick, taking the fee from each step's input;
 * pools with an adaptive fee add a volatility fee that grows as the swap crosses tick groups
 * and decays with time since the last large swap.
 */
export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const POOL_DISC = [63, 149, 209, 12, 225, 128, 99, 9];
const FIXED_ARRAY_DISC = [69, 97, 189, 190, 110, 7, 66, 187];
const DYNAMIC_ARRAY_DISC = [17, 216, 246, 142, 225, 199, 218, 56];
const ORACLE_DISC = [139, 194, 131, 179, 140, 179, 229, 244];
const SWAP_V2 = [43, 4, 237, 11, 26, 201, 30, 98];
const POOL_SIZE = 653;
const ORACLE_SIZE = 254;
const TICKS = 88;
const TICK_SIZE = 113;
/**
 * A trade's compute, measured on mainnet for whole transactions (accounts and wrapping
 * included): up to about 68k in one step, about 7k more for each tick it crosses, and 8k to
 * 9k for each further step an adaptive fee splits it into.
 */
const UNITS = 200_000;
const UNITS_FIRST_STEP = 75_000;
const UNITS_PER_STEP = 9_000;
const UNITS_PER_CROSS = 3_000;

/** Adaptive fee settings and state, from the pool's oracle account. */
interface AdaptiveFee {
  filterPeriod: bigint;
  decayPeriod: bigint;
  reductionFactor: bigint;
  controlFactor: bigint;
  maxVolatility: number;
  tickGroupSize: number;
  lastReferenceUpdate: bigint;
  lastMajorSwap: bigint;
  volatilityReference: number;
  tickGroupReference: number;
  volatility: number;
}

/** A tick array's initialized ticks: where a swap stops, and the liquidity it adds. */
interface TickArray {
  start: number;
  ticks: { offset: number; net: bigint }[];
}

export interface OrcaVenue extends DexVenueBase<'orca'> {
  /** Whether the coin is the pool's token A (else token B). */
  coinIsA: boolean;
  vaultA: SolAddress;
  vaultB: SolAddress;
  tickSpacing: number;
  /** Millionths. */
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tick: number;
  /** The chain's clock when the pool was read: the adaptive fee decays with it. */
  clock: ChainClock;
  adaptive: AdaptiveFee | null;
  /** When an adaptive pool opens to trading (Unix seconds). */
  tradeFrom: bigint;
  /** The arrays around the current tick, both ways, as far as a swap reads them. */
  arrays: TickArray[];
}

interface PoolState {
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tick: number;
  mintA: SolAddress;
  vaultA: SolAddress;
  mintB: SolAddress;
  vaultB: SolAddress;
}

/** Whirlpool: Borsh, fixed-size, so at fixed offsets after the discriminator. */
export function decodeWhirlpool(data: Uint8Array): PoolState | null {
  if (data.length !== POOL_SIZE || !hasDiscriminator(data, POOL_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    tickSpacing: at(41).u16(),
    feeRate: at(45).u16(),
    liquidity: at(49).u128(),
    sqrtPrice: at(65).u128(),
    tick: at(81).u32() | 0,
    mintA: at(101).pubkey(),
    vaultA: at(133).pubkey(),
    mintB: at(181).pubkey(),
    vaultB: at(213).pubkey(),
  };
}

/**
 * Oracle (packed): the pool, when trading opens, the adaptive fee's constants (34 bytes
 * from 48) and its variables (44 bytes from 82), then reserved space.
 */
function decodeOracle(data: Uint8Array): { tradeFrom: bigint; fee: AdaptiveFee } | null {
  if (data.length < ORACLE_SIZE || !hasDiscriminator(data, ORACLE_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    tradeFrom: at(40).u64(),
    fee: {
      filterPeriod: BigInt(at(48).u16()),
      decayPeriod: BigInt(at(50).u16()),
      reductionFactor: BigInt(at(52).u16()),
      controlFactor: BigInt(at(54).u32()),
      maxVolatility: at(58).u32(),
      tickGroupSize: at(62).u16(),
      lastReferenceUpdate: at(82).u64(),
      lastMajorSwap: at(90).u64(),
      volatilityReference: at(98).u32(),
      tickGroupReference: at(102).u32() | 0,
      volatility: at(106).u32(),
    },
  };
}

/** A tick array account, or null when it is none of this pool's. */
function decodeTickArray(data: Uint8Array, pool: SolAddress): TickArray | null {
  const at = (o: number) => new Reader(data, o);
  const start = at(8).u32() | 0;
  const ticks: TickArray['ticks'] = [];
  if (hasDiscriminator(data, FIXED_ARRAY_DISC)) {
    if (data.length !== 8 + 36 + TICK_SIZE * TICKS || at(12 + TICK_SIZE * TICKS).pubkey() !== pool)
      return null;
    for (let i = 0; i < TICKS; i++) {
      const o = 12 + i * TICK_SIZE;
      if (data[o]) ticks.push({ offset: i, net: at(o + 1).i128() });
    }
    return { start, ticks };
  }
  if (hasDiscriminator(data, DYNAMIC_ARRAY_DISC)) {
    if (at(12).pubkey() !== pool) return null;
    const bitmap = at(44).u128();
    // Each tick is one byte when uninitialized, the byte and its data when initialized.
    let o = 60;
    for (let i = 0; i < TICKS; i++) {
      if (!((bitmap >> BigInt(i)) & 1n)) {
        o += 1;
        continue;
      }
      ticks.push({ offset: i, net: data[o] === 1 ? at(o + 1).i128() : 0n });
      o += TICK_SIZE;
    }
    return { start, ticks };
  }
  return null;
}

const tickArrayAddress = (pool: SolAddress, start: number) =>
  findProgramAddress([seed('tick_array'), pool, seed(String(start))], ORCA_WHIRLPOOL_PROGRAM);

const oracleAddress = (pool: SolAddress) =>
  findProgramAddress([seed('oracle'), pool], ORCA_WHIRLPOOL_PROGRAM);

/** The config anyone opens pools under, and the tick spacings of its fixed fee tiers. */
const WHIRLPOOLS_CONFIG = '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ';
const FEE_TIER_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256];

/**
 * Where that config's fixed-fee pools of `x` and `y` are (most do not exist), from their
 * addresses alone: the pool's seeds name the two mints in byte order, then the spacing.
 */
export function whirlpoolAddresses(x: SolAddress, y: SolAddress): SolAddress[] {
  const bx = addressBytes(x);
  const by = addressBytes(y);
  const i = bx.findIndex((b, k) => b !== by[k]);
  const [a, b] = i >= 0 && (bx[i] as number) > (by[i] as number) ? [y, x] : [x, y];
  return FEE_TIER_SPACINGS.map((s) =>
    findProgramAddress(
      [seed('whirlpool'), WHIRLPOOLS_CONFIG, a, b, Uint8Array.of(s & 0xff, s >> 8)],
      ORCA_WHIRLPOOL_PROGRAM,
    ),
  );
}

function validStart(start: number, spacing: number): boolean {
  const span = TICKS * spacing;
  if (start < MIN_TICK || start > MAX_TICK) {
    if (start > MIN_TICK) return false;
    return start === MIN_TICK - ((MIN_TICK % span) + span);
  }
  return start % span === 0;
}

/** The arrays a swap from `tick` walks, in order (the program's `get_start_tick_indexes`). */
function startIndexes(tick: number, spacing: number, aToB: boolean): number[] {
  const span = TICKS * spacing;
  const base = floorDiv(tick, span) * span;
  const offsets = aToB ? [0, -1, -2] : tick + spacing >= base + span ? [1, 2, 3] : [0, 1, 2];
  return offsets.map((o) => base + o * span).filter((s) => validStart(s, spacing));
}

/** Every array either direction may walk from `tick`. */
const aroundIndexes = (tick: number, spacing: number) => [
  ...new Set([...startIndexes(tick, spacing, true), ...startIndexes(tick, spacing, false)]),
];

/** Whether `side` puts token A into the pool. */
const aIn = (v: OrcaVenue, side: Side) => (side === 'sell') === v.coinIsA;

const VOLATILITY_SCALE = 10_000;
const FEE_RATE_HARD_LIMIT = 100_000n;
const MAX_REFERENCE_AGE = 3_600n;

/** The program's `FeeRateManager`: a fixed rate, or the adaptive fee as a swap moves. */
class FeeRates {
  private group = 0;
  private lower: [number, bigint] | null = null;
  private upper: [number, bigint] | null = null;
  private readonly f: AdaptiveFee | null;

  constructor(
    private readonly aToB: boolean,
    tick: number,
    now: bigint,
    private readonly base: number,
    adaptive: AdaptiveFee | null,
  ) {
    if (!adaptive) {
      this.f = null;
      return;
    }
    const f = { ...adaptive };
    this.f = f;
    this.group = floorDiv(tick, f.tickGroupSize);
    // update_reference
    const latest =
      f.lastReferenceUpdate > f.lastMajorSwap ? f.lastReferenceUpdate : f.lastMajorSwap;
    if (now < latest) refuse();
    if (now - f.lastReferenceUpdate > MAX_REFERENCE_AGE) {
      f.tickGroupReference = this.group;
      f.volatilityReference = 0;
    } else if (now - latest >= f.filterPeriod) {
      f.tickGroupReference = this.group;
      f.volatilityReference =
        now - latest < f.decayPeriod
          ? Number((BigInt(f.volatility) * f.reductionFactor) / 10_000n)
          : 0;
    }
    if (f.volatilityReference > f.maxVolatility) refuse();
    const delta = Math.ceil((f.maxVolatility - f.volatilityReference) / VOLATILITY_SCALE);
    const lowerIndex = f.tickGroupReference - delta;
    const upperIndex = f.tickGroupReference + delta;
    const lowerTick = lowerIndex * f.tickGroupSize;
    const upperTick = upperIndex * f.tickGroupSize + f.tickGroupSize;
    if (lowerTick > MIN_TICK) this.lower = [lowerIndex, sqrtPriceFromTick(lowerTick)];
    if (upperTick < MAX_TICK) this.upper = [upperIndex, sqrtPriceFromTick(upperTick)];
  }

  updateVolatility(): void {
    const f = this.f;
    if (!f) return;
    const v =
      f.volatilityReference + Math.abs(f.tickGroupReference - this.group) * VOLATILITY_SCALE;
    f.volatility = Math.min(v, f.maxVolatility);
  }

  total(): bigint {
    const f = this.f;
    if (!f) return BigInt(this.base);
    const crossed = BigInt(f.volatility * f.tickGroupSize);
    const p = f.controlFactor * crossed * crossed;
    const d = 100_000n * 10_000n * 10_000n;
    let adaptive = p / d + (p % d ? 1n : 0n);
    if (adaptive > FEE_RATE_HARD_LIMIT) adaptive = FEE_RATE_HARD_LIMIT;
    const total = BigInt(this.base) + adaptive;
    return total > FEE_RATE_HARD_LIMIT ? FEE_RATE_HARD_LIMIT : total;
  }

  /** The step's target, bounded to the current tick group, and whether stepping was skipped. */
  bounded(target: bigint, liquidity: bigint): [bigint, boolean] {
    const f = this.f;
    if (!f) return [target, false];
    if (f.controlFactor === 0n || liquidity === 0n) return [target, true];
    const min = (a: bigint, b: bigint) => (a < b ? a : b);
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    if (this.lower && this.group < this.lower[0])
      return [this.aToB ? target : min(target, this.lower[1]), true];
    if (this.upper && this.group > this.upper[0])
      return [this.aToB ? max(target, this.upper[1]) : target, true];
    const edge = this.aToB
      ? this.group * f.tickGroupSize
      : this.group * f.tickGroupSize + f.tickGroupSize;
    const edgePrice = sqrtPriceFromTick(Math.min(Math.max(edge, MIN_TICK), MAX_TICK));
    return [this.aToB ? max(target, edgePrice) : min(target, edgePrice), false];
  }

  advance(skipped: boolean, price: bigint, nextTickPrice: bigint, nextTick: number): void {
    const f = this.f;
    if (!f) return;
    if (skipped) {
      const size = f.tickGroupSize;
      let tick: number;
      let onEdge: boolean;
      if (price === nextTickPrice) {
        tick = nextTick;
        onEdge = nextTick % size === 0;
      } else {
        tick = tickFromSqrtPrice(price);
        onEdge = tick % size === 0 && price === sqrtPriceFromTick(tick);
      }
      const last = onEdge && !this.aToB ? tick / size - 1 : floorDiv(tick, size);
      if ((this.aToB && last < this.group) || (!this.aToB && last > this.group)) {
        this.group = last;
        this.updateVolatility();
      }
    }
    this.group += this.aToB ? -1 : 1;
  }
}

/** The arrays a swap walks, as the program builds its sequence from the accounts given. */
function sequence(v: OrcaVenue, aToB: boolean): TickArray[] {
  const out: TickArray[] = [];
  for (const start of startIndexes(v.tick, v.tickSpacing, aToB)) {
    const a = v.arrays.find((x) => x.start === start);
    if (!a) break;
    out.push(a);
  }
  return out.length > 0 ? out : refuse();
}

/** The next initialized tick a swap stops at (`get_next_initialized_tick_index`). */
function nextTickOf(
  seq: TickArray[],
  tick: number,
  spacing: number,
  aToB: boolean,
  from: number,
): [number, number] {
  const span = TICKS * spacing;
  let search = tick;
  for (let i = from; ; i++) {
    const a = seq[i];
    if (!a) refuse();
    // The search range of an array, shifted one tick spacing left when moving right.
    const lower = a.start - (aToB ? 0 : spacing);
    if (search < lower || search >= lower + span) refuse();
    let offset = floorDiv(search - a.start, spacing) + (aToB ? 0 : 1);
    const stops = new Set(a.ticks.map((t) => t.offset));
    while (offset >= 0 && offset < TICKS) {
      if (stops.has(offset)) return [i, a.start + offset * spacing];
      offset += aToB ? -1 : 1;
    }
    if (aToB && a.start <= MIN_TICK) return [i, MIN_TICK];
    if (!aToB && a.start + span > MAX_TICK) return [i, MAX_TICK];
    if (i + 1 === seq.length) return [i, aToB ? a.start : a.start + span - 1];
    search = aToB ? a.start - 1 : a.start + span - 1;
  }
}

/** The liquidity a crossed tick adds or removes, or 0 when it holds none (`get_tick`). */
function netAt(a: TickArray, tick: number, spacing: number): bigint {
  const span = TICKS * spacing;
  if (tick < a.start || tick >= a.start + span) return 0n;
  if (tick < MIN_TICK || tick > MAX_TICK || tick % spacing !== 0) return 0n;
  const offset = (tick - a.start) / spacing;
  return a.ticks.find((t) => t.offset === offset)?.net ?? 0n;
}

/**
 * An exact-input swap of `amount`, walking the ticks as the program does: what it pays, and
 * the ticks it stopped at and the steps it took (its compute grows with both).
 */
function walk(v: OrcaVenue, amount: bigint, aToB: boolean) {
  const limit = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  if (aToB ? limit >= v.sqrtPrice : limit <= v.sqrtPrice) refuse();
  const spacing = v.tickSpacing;
  const seq = sequence(v, aToB);
  const fees = new FeeRates(aToB, v.tick, v.clock.unixTime, v.feeRate, v.adaptive);
  let remaining = amount;
  let out = 0n;
  let price = v.sqrtPrice;
  let tick = v.tick;
  let liquidity = v.liquidity;
  let arrayIndex = 0;
  let crossed = 0;
  let steps = 0;
  while (remaining > 0n && price !== limit) {
    const [nextArray, nextTick] = nextTickOf(seq, tick, spacing, aToB, arrayIndex);
    const nextTickPrice = sqrtPriceFromTick(nextTick);
    const target = aToB
      ? nextTickPrice > limit
        ? nextTickPrice
        : limit
      : nextTickPrice < limit
        ? nextTickPrice
        : limit;
    for (;;) {
      fees.updateVolatility();
      const rate = fees.total();
      const [bounded, skipped] = fees.bounded(target, liquidity);
      const step = computeSwapIn(remaining, rate, liquidity, price, bounded, aToB);
      remaining -= step.amountIn + step.fee;
      if (remaining < 0n) refuse();
      out += step.amountOut;
      if (out > U64_MAX) refuse();
      steps++;
      if (step.nextPrice === nextTickPrice) {
        const a = seq[nextArray] ?? refuse();
        const net = netAt(a, nextTick, spacing);
        crossed++;
        liquidity += aToB ? -net : net;
        if (liquidity < 0n || liquidity >> 128n) refuse();
        const offset = floorDiv(nextTick - a.start, spacing);
        arrayIndex =
          (aToB && offset === 0) || (!aToB && offset === TICKS - 1) ? nextArray + 1 : nextArray;
        tick = aToB ? nextTick - 1 : nextTick;
      } else if (step.nextPrice !== price) {
        tick = tickFromSqrtPrice(step.nextPrice);
      }
      price = step.nextPrice;
      fees.advance(skipped, price, nextTickPrice, nextTick);
      if (remaining === 0n || price === target) break;
    }
  }
  // A partial fill (the pool emptied to its price limit) is not quoted.
  return remaining === 0n ? { out, crossed, steps } : refuse();
}

/** Each pool's tick spacing and the arrays read last time, to read along with it. */
const lastRead = new Map<SolAddress, { spacing: number; tick: number }>();

export const orca: DexModule<OrcaVenue> = {
  dex: 'orca',
  program: ORCA_WHIRLPOOL_PROGRAM,
  units: UNITS,

  unitsFor(v, side, amountIn) {
    try {
      const { crossed, steps } = walk(v, amountIn, aIn(v, side));
      return UNITS_FIRST_STEP + UNITS_PER_STEP * Math.max(0, steps - 1) + UNITS_PER_CROSS * crossed;
    } catch {
      // A swap the pool cannot fill fails on chain whatever it is given.
      return UNITS;
    }
  },

  async load(ctx, pool, mint) {
    const before = lastRead.get(pool);
    const guess = before ? aroundIndexes(before.tick, before.spacing) : [];
    const oracle = oracleAddress(pool);
    const accs = await ctx.read([
      pool,
      SYSVAR_CLOCK,
      oracle,
      ...guess.map((s) => tickArrayAddress(pool, s)),
    ]);
    const [poolAcc = null, clockAcc = null, oracleAcc = null] = accs;
    if (poolAcc?.owner !== ORCA_WHIRLPOOL_PROGRAM) return null;
    const s = decodeWhirlpool(poolAcc.data);
    const clock = clockAcc ? decodeClock(clockAcc.data) : null;
    if (!s || !clock || s.tickSpacing === 0) return null;
    const coinIsA = s.mintA === mint;
    if (!coinIsA && s.mintB !== mint) return null;
    const quote = await ctx.quoteAsset(coinIsA ? s.mintB : s.mintA);
    if (!quote) return null;

    let oracleState: ReturnType<typeof decodeOracle> = null;
    if (oracleAcc && oracleAcc.data.length > 0) {
      if (oracleAcc.owner !== ORCA_WHIRLPOOL_PROGRAM) return null;
      oracleState = decodeOracle(oracleAcc.data);
      if (!oracleState) return null;
    }

    const needed = aroundIndexes(s.tick, s.tickSpacing);
    const got = new Map(guess.map((start, i) => [start, accs[3 + i] ?? null]));
    const missing = needed.filter((start) => !got.has(start));
    if (missing.length > 0) {
      const more = await ctx.read(missing.map((start) => tickArrayAddress(pool, start)));
      missing.forEach((start, i) => got.set(start, more[i] ?? null));
    }
    const arrays: TickArray[] = [];
    for (const start of needed) {
      const acc = got.get(start) ?? null;
      // An array never created holds no ticks: the program reads it as zeroed.
      if (!acc || acc.data.length === 0) {
        arrays.push({ start, ticks: [] });
        continue;
      }
      const a = acc.owner === ORCA_WHIRLPOOL_PROGRAM ? decodeTickArray(acc.data, pool) : null;
      if (!a || a.start !== start) return null;
      arrays.push(a);
    }
    if (lastRead.size > 200) lastRead.clear();
    lastRead.set(pool, { spacing: s.tickSpacing, tick: s.tick });
    return {
      kind: 'dex',
      dex: 'orca',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      coinIsA,
      vaultA: s.vaultA,
      vaultB: s.vaultB,
      tickSpacing: s.tickSpacing,
      feeRate: s.feeRate,
      liquidity: s.liquidity,
      sqrtPrice: s.sqrtPrice,
      tick: s.tick,
      clock,
      adaptive: oracleState?.fee ?? null,
      tradeFrom: oracleState?.tradeFrom ?? 0n,
      arrays,
    };
  },

  coinOf(data) {
    const s = decodeWhirlpool(data);
    return s ? coinOfPair(s.mintA, s.mintB) : null;
  },

  label: () => 'Orca Whirlpool',

  quote(v, side, amountIn) {
    return quoteOrZero(() =>
      amountIn > 0n && amountIn <= U64_MAX ? walk(v, amountIn, aIn(v, side)).out : 0n,
    );
  },

  spot(v) {
    const price = (Number(v.sqrtPrice) / 2 ** 64) ** 2;
    return v.coinIsA ? price : price > 0 ? 1 / price : 0;
  },

  idle(v) {
    if (v.clock.unixTime < v.tradeFrom) return 'This Orca pool has not opened to trading yet.';
    return null;
  },

  swap(v, side, user, amountIn, minOut) {
    const aToB = aIn(v, side);
    const coin = { mint: v.mint, program: v.tokenProgram };
    const quote = { mint: v.quote.mint, program: v.quote.program };
    const [a, b] = v.coinIsA ? [coin, quote] : [quote, coin];
    const starts = startIndexes(v.tick, v.tickSpacing, aToB);
    const arrays = [0, 1, 2].map((i) =>
      tickArrayAddress(v.pool, starts[Math.min(i, starts.length - 1)] ?? 0),
    );
    return {
      programId: ORCA_WHIRLPOOL_PROGRAM,
      keys: [
        meta(a.program),
        meta(b.program),
        meta(MEMO_PROGRAM),
        meta(user, false, true),
        meta(v.pool, true),
        meta(a.mint),
        meta(b.mint),
        meta(associatedTokenAddress(user, a.mint, a.program), true),
        meta(v.vaultA, true),
        meta(associatedTokenAddress(user, b.mint, b.program), true),
        meta(v.vaultB, true),
        ...arrays.map((t) => meta(t, true)),
        meta(oracleAddress(v.pool), true),
      ],
      // Exact input, no price limit, no remaining accounts.
      data: concat(SWAP_V2, u64(amountIn), u64(minOut), new Uint8Array(16), [1, aToB ? 1 : 0, 0]),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 43 || !hasDiscriminator(data, SWAP_V2)) return null;
    const r = new Reader(data, 8);
    return { amountIn: r.u64(), minOut: r.u64() };
  },
};
