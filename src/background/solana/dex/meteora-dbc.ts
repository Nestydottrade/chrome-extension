import type { SolAddress } from '../../../shared/solana';
import {
  SYSVAR_CLOCK,
  SYSVAR_INSTRUCTIONS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  addressBytes,
  findProgramAddress,
  seed,
} from '../address';
import { Reader, decodeClock, hasDiscriminator, type ChainClock } from '../layouts';
import { concat, meta, u64, type Instruction } from '../tx';
import { userAccounts } from './accounts';
import {
  ONE_Q64,
  U64_MAX,
  deltaBase,
  deltaQuote,
  feeOn,
  fitU64,
  nextSqrtFromInput,
  rateLimitedFee,
  scheduledFee,
  volatilityFee,
} from './meteora-math';
import { quoteOrZero, refuse } from './refusal';
import type { DexModule, DexVenueBase } from './types';

/**
 * Meteora's Dynamic Bonding Curve, the launch curve behind Jupiter Studio, Bags, Believe
 * and other launchpads. Facts from its source (MeteoraAg/dynamic-bonding-curve): a pool
 * prices on up to 20 segments of concentrated liquidity its config lays out, from a start
 * price up to the migration price; a trade must fill whole within them, and none trades once
 * the quote raised reaches the migration threshold. The fee (a decaying or rate-limited base
 * fee plus a volatility fee, at most 99%) comes off a buy's input when the config collects
 * it in the quote token, else off the output.
 */
export const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Owns every pool's vaults. */
export const DBC_POOL_AUTHORITY = findProgramAddress([seed('pool_authority')], METEORA_DBC_PROGRAM);
const EVENT_AUTHORITY = findProgramAddress([seed('__event_authority')], METEORA_DBC_PROGRAM);

const POOL_DISC = [213, 224, 5, 209, 98, 69, 119, 92];
const CONFIG_DISC = [26, 108, 14, 123, 116, 230, 129, 43];
const SWAP = [248, 198, 158, 145, 225, 117, 135, 200];
const POOL_SIZE = 424;
const CONFIG_SIZE = 1048;
const CURVE_AT = 408;
const CURVE_POINTS = 20;
const MAX_FEE = 990_000_000n;

/** The base fee: decaying with time from the pool's activation, or rate-limited by size. */
export type DbcBaseFee =
  | {
      kind: 'scheduler';
      exponential: boolean;
      cliff: bigint;
      periods: bigint;
      /** Slots or seconds per period, as the config's activation counts. */
      frequency: bigint;
      reduction: bigint;
    }
  | { kind: 'limiter'; cliff: bigint; incrementBps: bigint; duration: bigint; reference: bigint };

/** A curve point: liquidity up to `sqrtPrice` from the point before it. */
interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export interface MeteoraDbcVenue extends DexVenueBase<'meteora-dbc'> {
  config: SolAddress;
  baseVault: SolAddress;
  quoteVault: SolAddress;
  /** Slots (activation type 0) or seconds (1). */
  activationType: number;
  activationPoint: bigint;
  /** The chain's clock when the pool was read: the base fee may move with it. */
  clock: ChainClock;
  /** 0: in the quote token (off a buy's input), 1: off the output. */
  collectFeeMode: number;
  baseFee: DbcBaseFee;
  /** The volatility fee's inputs; it holds still between swaps. */
  volatility: { accumulator: bigint; binStep: bigint; control: bigint } | null;
  sqrtPrice: bigint;
  quoteReserve: bigint;
  /** Where the curve completes: the quote it raises, and the price it stops at. */
  migrationThreshold: bigint;
  migrationSqrtPrice: bigint;
  sqrtStartPrice: bigint;
  curve: CurvePoint[];
}

export interface DbcPoolState {
  accumulator: bigint;
  config: SolAddress;
  /** Who launched it: a launchpad's own key for some (Bags signs every launch). */
  creator: SolAddress;
  baseMint: SolAddress;
  baseVault: SolAddress;
  quoteVault: SolAddress;
  /** The coin left in the pool: what the curve still sells, and what its pool will get. */
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  /** The coin's token program: 0 SPL Token, 1 Token-2022. */
  poolType: number;
  isMigrated: boolean;
  /** 0 on the curve; 1 once complete, 2 its vesting locked, 3 its pool created. */
  migrationProgress: number;
  /** Unix seconds, when the curve completed; 0 before. */
  finishCurveTime: bigint;
}

export interface DbcConfigState {
  quoteMint: SolAddress;
  baseFee: DbcBaseFee | null;
  volatility: { binStep: bigint; control: bigint } | null;
  collectFeeMode: number;
  /** The pool it migrates to: 0 DAMM v1, 1 DAMM v2. */
  migrationOption: number;
  activationType: number;
  /** The coin's decimals. */
  tokenDecimal: number;
  quoteTokenFlag: number;
  migrationThreshold: bigint;
  /** The coin its pool gets when it migrates: kept back from the curve's sales. */
  migrationBaseThreshold: bigint;
  migrationSqrtPrice: bigint;
  sqrtStartPrice: bigint;
  curve: CurvePoint[];
}

export const DBC_POOL_SIZE = POOL_SIZE;

/** VirtualPool: zero-copy, at fixed offsets after the discriminator. */
export function decodeDbcPool(data: Uint8Array): DbcPoolState | null {
  if (data.length !== POOL_SIZE || !hasDiscriminator(data, POOL_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    accumulator: at(40).u128(),
    config: at(72).pubkey(),
    creator: at(104).pubkey(),
    baseMint: at(136).pubkey(),
    baseVault: at(168).pubkey(),
    quoteVault: at(200).pubkey(),
    baseReserve: at(232).u64(),
    quoteReserve: at(240).u64(),
    sqrtPrice: at(280).u128(),
    activationPoint: at(296).u64(),
    poolType: at(304).u8(),
    isMigrated: at(305).u8() !== 0,
    migrationProgress: at(308).u8(),
    finishCurveTime: at(344).u64(),
  };
}

/** A pool's address: one per config, coin and quote token. */
export function dbcPoolAddress(
  config: SolAddress,
  base: SolAddress,
  quote: SolAddress,
): SolAddress {
  const [b, q] = [addressBytes(base), addressBytes(quote)];
  const [high, low] = compareBytes(b, q) > 0 ? [b, q] : [q, b];
  return findProgramAddress([seed('pool'), config, high, low], METEORA_DBC_PROGRAM);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function decodeBaseFee(data: Uint8Array): DbcBaseFee | null {
  const at = (o: number) => new Reader(data, o);
  const cliff = at(104).u64();
  // Stored in reverse so older configs read alike: the first factor last.
  const second = at(112).u64();
  const third = at(120).u64();
  const first = BigInt(at(128).u16());
  const mode = at(130).u8();
  if (mode === 0 || mode === 1) {
    const exponential = mode === 1;
    return {
      kind: 'scheduler',
      exponential,
      cliff,
      periods: first,
      frequency: second,
      reduction: third,
    };
  }
  if (mode === 2)
    return { kind: 'limiter', cliff, incrementBps: first, duration: second, reference: third };
  return null;
}

/** PoolConfig: the fees, the curve and where it completes. */
export function decodeDbcConfig(data: Uint8Array): DbcConfigState | null {
  if (data.length !== CONFIG_SIZE || !hasDiscriminator(data, CONFIG_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  const curve: CurvePoint[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const r = at(CURVE_AT + i * 32);
    curve.push({ sqrtPrice: r.u128(), liquidity: r.u128() });
  }
  return {
    quoteMint: at(8).pubkey(),
    baseFee: decodeBaseFee(data),
    volatility:
      at(136).u8() !== 0
        ? { binStep: BigInt(at(152).u16()), control: BigInt(at(148).u32()) }
        : null,
    collectFeeMode: at(232).u8(),
    migrationOption: at(233).u8(),
    activationType: at(234).u8(),
    tokenDecimal: at(235).u8(),
    quoteTokenFlag: at(238).u8(),
    migrationThreshold: at(264).u64(),
    migrationBaseThreshold: at(272).u64(),
    migrationSqrtPrice: at(280).u128(),
    sqrtStartPrice: at(392).u128(),
    curve,
  };
}

const flagProgram = (flag: number) =>
  flag === 0 ? TOKEN_PROGRAM : flag === 1 ? TOKEN_2022_PROGRAM : null;

/** Slot or Unix time, as the config's activation counts. */
const pointOf = (v: MeteoraDbcVenue) => (v.activationType === 0 ? v.clock.slot : v.clock.unixTime);

const complete = (v: MeteoraDbcVenue) => v.quoteReserve >= v.migrationThreshold;

function baseFeeOf(v: MeteoraDbcVenue, input: bigint, buy: boolean): bigint {
  const f = v.baseFee;
  const point = pointOf(v);
  if (f.kind === 'scheduler') {
    if (f.frequency === 0n) return f.cliff;
    if (point < v.activationPoint) refuse();
    const passed = (point - v.activationPoint) / f.frequency;
    const period = passed < f.periods ? passed : f.periods;
    return scheduledFee(f.exponential, f.cliff, f.reduction, period, false);
  }
  const zero = f.reference === 0n && f.duration === 0n && f.incrementBps === 0n;
  if (zero || !buy || point > v.activationPoint + f.duration) return f.cliff;
  return rateLimitedFee(input, f.cliff, f.reference, f.incrementBps, MAX_FEE);
}

/** The coin a buy of `amountIn` gets, up the curve's segments to the migration price. */
function quoteToBase(v: MeteoraDbcVenue, amountIn: bigint): bigint {
  let price = v.sqrtPrice;
  let left = amountIn;
  let out = 0n;
  for (const { sqrtPrice: upper, liquidity } of v.curve) {
    if (upper === 0n || liquidity === 0n) break;
    const stop = v.migrationSqrtPrice < upper ? v.migrationSqrtPrice : upper;
    if (stop <= price) continue;
    const room = deltaQuote(price, stop, liquidity, true);
    if (left < room) {
      const next = nextSqrtFromInput(price, liquidity, left, false);
      out = fitU64(out + fitU64(deltaBase(price, next, liquidity, false)));
      left = 0n;
      break;
    }
    out = fitU64(out + fitU64(deltaBase(price, stop, liquidity, false)));
    left -= room;
    price = stop;
    if (stop === v.migrationSqrtPrice) break;
  }
  // A buy that would run past the migration price does not fill.
  return left === 0n ? out : refuse();
}

/** The quote a sale of `amountIn` gets, down the curve's segments to its start price. */
function baseToQuote(v: MeteoraDbcVenue, amountIn: bigint): bigint {
  const c = v.curve;
  let price = v.sqrtPrice;
  let left = amountIn;
  let out = 0n;
  for (let i = c.length - 2; i >= 0; i--) {
    const lower = c[i]?.sqrtPrice ?? 0n;
    const liquidity = c[i + 1]?.liquidity ?? 0n;
    if (lower === 0n || (c[i]?.liquidity ?? 0n) === 0n || lower >= price) continue;
    const room = deltaBase(lower, price, liquidity, true);
    if (left < room) {
      const next = nextSqrtFromInput(price, liquidity, left, true);
      out = fitU64(out + fitU64(deltaQuote(next, price, liquidity, false)));
      left = 0n;
      break;
    }
    out = fitU64(out + fitU64(deltaQuote(lower, price, liquidity, false)));
    left -= room;
    price = lower;
  }
  if (left !== 0n) {
    const liquidity = c[0]?.liquidity ?? 0n;
    let next = nextSqrtFromInput(price, liquidity, left, true);
    if (next < v.sqrtStartPrice) {
      next = v.sqrtStartPrice;
      const used = fitU64(deltaBase(next, price, liquidity, true));
      if (used > left) refuse();
      left -= used;
    } else {
      left = 0n;
    }
    out = fitU64(out + fitU64(deltaQuote(next, price, liquidity, false)));
  }
  return left === 0n ? out : refuse();
}

/** Each pool's config: it never changes, so later reads take it along with the pool. */
const configOf = new Map<SolAddress, SolAddress>();

export const meteoraDbc: DexModule<MeteoraDbcVenue> = {
  dex: 'meteora-dbc',
  program: METEORA_DBC_PROGRAM,
  units: 150_000,

  async load(ctx, pool, mint) {
    const before = configOf.get(pool);
    const accs = await ctx.read(before ? [pool, SYSVAR_CLOCK, before] : [pool, SYSVAR_CLOCK]);
    const [poolAcc = null, clockAcc = null] = accs;
    let cfgAcc = accs[2] ?? null;
    if (poolAcc?.owner !== METEORA_DBC_PROGRAM) return null;
    const s = decodeDbcPool(poolAcc.data);
    if (s?.baseMint !== mint) return null;
    if (before !== s.config) [cfgAcc = null] = await ctx.read([s.config]);
    const c = cfgAcc?.owner === METEORA_DBC_PROGRAM ? decodeDbcConfig(cfgAcc.data) : null;
    const clock = clockAcc ? decodeClock(clockAcc.data) : null;
    if (!c?.baseFee || !clock || c.collectFeeMode > 1) return null;
    if (flagProgram(s.poolType) !== ctx.coinProgram) return null;
    const quote = await ctx.quoteAsset(c.quoteMint);
    if (!quote || quote.program !== flagProgram(c.quoteTokenFlag)) return null;
    if (configOf.size > 500) configOf.clear();
    configOf.set(pool, s.config);
    return {
      kind: 'dex',
      dex: 'meteora-dbc',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      config: s.config,
      baseVault: s.baseVault,
      quoteVault: s.quoteVault,
      activationType: c.activationType,
      activationPoint: s.activationPoint,
      clock,
      collectFeeMode: c.collectFeeMode,
      baseFee: c.baseFee,
      volatility: c.volatility && { accumulator: s.accumulator, ...c.volatility },
      sqrtPrice: s.sqrtPrice,
      quoteReserve: s.quoteReserve,
      migrationThreshold: c.migrationThreshold,
      migrationSqrtPrice: c.migrationSqrtPrice,
      sqrtStartPrice: c.sqrtStartPrice,
      curve: c.curve,
    };
  },

  coinOf: (data) => decodeDbcPool(data)?.baseMint ?? null,

  label: () => 'Meteora DBC',

  quote(v, side, amountIn) {
    return quoteOrZero(() => {
      if (amountIn <= 0n || amountIn > U64_MAX || complete(v)) return 0n;
      const buy = side === 'buy';
      const vol = v.volatility;
      const total =
        baseFeeOf(v, amountIn, buy) +
        (vol ? volatilityFee(vol.accumulator, vol.binStep, vol.control) : 0n);
      const fee = total > MAX_FEE ? MAX_FEE : total;
      if (buy && v.collectFeeMode === 0) return quoteToBase(v, amountIn - feeOn(amountIn, fee));
      const out = buy ? quoteToBase(v, amountIn) : baseToQuote(v, amountIn);
      return out - feeOn(out, fee);
    });
  },

  spot: (v) => (Number(v.sqrtPrice) / Number(ONE_Q64)) ** 2,

  idle(v) {
    return complete(v)
      ? 'This Meteora bonding curve is complete. Trading moves to its pool once it migrates.'
      : null;
  },

  swap(v, side, user, amountIn, minOut) {
    const { source, destination } = userAccounts(v, side, user);
    return {
      programId: METEORA_DBC_PROGRAM,
      keys: [
        meta(DBC_POOL_AUTHORITY),
        meta(v.config),
        meta(v.pool, true),
        meta(source, true),
        meta(destination, true),
        meta(v.baseVault, true),
        meta(v.quoteVault, true),
        meta(v.mint),
        meta(v.quote.mint),
        meta(user, false, true),
        meta(v.tokenProgram),
        meta(v.quote.program),
        // No referral account: the program's own address stands in for none.
        meta(METEORA_DBC_PROGRAM),
        meta(EVENT_AUTHORITY),
        meta(METEORA_DBC_PROGRAM),
        // A rate-limited curve checks the transaction holds no other swap on it.
        ...(v.baseFee.kind === 'limiter' ? [meta(SYSVAR_INSTRUCTIONS)] : []),
      ],
      data: concat(SWAP, u64(amountIn), u64(minOut)),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 24 || !hasDiscriminator(data, SWAP)) return null;
    const r = new Reader(data, 8);
    return { amountIn: r.u64(), minOut: r.u64() };
  },
};
