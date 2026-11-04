import type { SolAddress } from '../../../shared/solana';
import {
  SYSVAR_CLOCK,
  SYSVAR_INSTRUCTIONS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  coinOfPair,
  findProgramAddress,
  seed,
} from '../address';
import { Reader, decodeClock, hasDiscriminator, type ChainClock } from '../layouts';
import type { Side } from '../pump';
import { concat, meta, u64, type Instruction } from '../tx';
import { userAccounts } from './accounts';
import {
  ONE_Q64,
  U64_MAX,
  bpsNumerator,
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
 * Meteora DAMM v2 (cp-amm), where Meteora's bonding curves graduate. Facts from its source
 * (MeteoraAg/damm-v2): a pool prices on concentrated liquidity between two square-root
 * prices, or (compounding pools) on its reserves as a constant product; the fee is a base
 * fee (fixed, decaying with time or market cap, or rate-limited by size) plus a volatility
 * fee, rounded up, and comes off the input or the output as the pool's fee mode says.
 */
export const METEORA_DAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const AUTHORITY = findProgramAddress([seed('pool_authority')], METEORA_DAMM_PROGRAM);
const EVENT_AUTHORITY = findProgramAddress([seed('__event_authority')], METEORA_DAMM_PROGRAM);

const POOL_DISC = [241, 154, 109, 4, 17, 177, 109, 188];
const SWAP = [248, 198, 158, 145, 225, 117, 135, 200];
const POOL_SIZE = 1112;
/** Fee modes: 0 in both tokens (off the output), 1 only in token B, 2 compounding. */
const COMPOUNDING = 2;
const MAX_FEE = [500_000_000n, 990_000_000n];

/** The base fee, by the schedule it follows. */
export type DammBaseFee =
  | {
      kind: 'time';
      exponential: boolean;
      cliff: bigint;
      periods: bigint;
      /** Slots or seconds per period, as the pool's activation counts. */
      frequency: bigint;
      reduction: bigint;
    }
  | {
      kind: 'limiter';
      cliff: bigint;
      incrementBps: bigint;
      duration: bigint;
      maxFeeBps: bigint;
      reference: bigint;
    }
  | {
      kind: 'mcap';
      exponential: boolean;
      cliff: bigint;
      periods: bigint;
      stepBps: bigint;
      expiration: bigint;
      reduction: bigint;
    };

export interface MeteoraDammVenue extends DexVenueBase<'meteora-damm'> {
  /** Whether the coin is the pool's token A (else token B). */
  coinIsA: boolean;
  vaultA: SolAddress;
  vaultB: SolAddress;
  /** 0 while swaps are enabled. */
  status: number;
  /** Opening, in slots (activation type 0) or seconds (1). */
  activationType: number;
  activationPoint: bigint;
  /** The chain's clock when the pool was read: the base fee may move with it. */
  clock: ChainClock;
  collectFeeMode: number;
  maxFee: bigint;
  baseFee: DammBaseFee;
  /** The volatility fee's inputs; it holds still between swaps. */
  volatility: { accumulator: bigint; binStep: bigint; control: bigint } | null;
  initSqrtPrice: bigint;
  sqrtPrice: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  liquidity: bigint;
  reserveA: bigint;
  reserveB: bigint;
}

interface PoolState {
  baseFee: DammBaseFee | null;
  volatility: MeteoraDammVenue['volatility'];
  initSqrtPrice: bigint;
  mintA: SolAddress;
  mintB: SolAddress;
  vaultA: SolAddress;
  vaultB: SolAddress;
  liquidity: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  activationType: number;
  status: number;
  flagA: number;
  flagB: number;
  collectFeeMode: number;
  feeVersion: number;
  reserveA: bigint;
  reserveB: bigint;
}

function decodeBaseFee(data: Uint8Array): DammBaseFee | null {
  const at = (o: number) => new Reader(data, o);
  const cliff = at(8).u64();
  const mode = at(16).u8();
  switch (mode) {
    case 0:
    case 1:
      return {
        kind: 'time',
        exponential: mode === 1,
        cliff,
        periods: BigInt(at(22).u16()),
        frequency: at(24).u64(),
        reduction: at(32).u64(),
      };
    case 2:
      return {
        kind: 'limiter',
        cliff,
        incrementBps: BigInt(at(22).u16()),
        duration: BigInt(at(24).u32()),
        maxFeeBps: BigInt(at(28).u32()),
        reference: at(32).u64(),
      };
    case 3:
    case 4:
      return {
        kind: 'mcap',
        exponential: mode === 4,
        cliff,
        periods: BigInt(at(22).u16()),
        stepBps: BigInt(at(24).u32()),
        expiration: BigInt(at(28).u32()),
        reduction: at(32).u64(),
      };
    default:
      return null;
  }
}

/** Pool: zero-copy, at fixed offsets after the discriminator. */
export function decodeDammPool(data: Uint8Array): PoolState | null {
  if (data.length !== POOL_SIZE || !hasDiscriminator(data, POOL_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    baseFee: decodeBaseFee(data),
    volatility:
      at(56).u8() !== 0
        ? {
            accumulator: at(120).u128(),
            binStep: BigInt(at(72).u16()),
            control: BigInt(at(68).u32()),
          }
        : null,
    initSqrtPrice: at(152).u128(),
    mintA: at(168).pubkey(),
    mintB: at(200).pubkey(),
    vaultA: at(232).pubkey(),
    vaultB: at(264).pubkey(),
    liquidity: at(360).u128(),
    sqrtMinPrice: at(424).u128(),
    sqrtMaxPrice: at(440).u128(),
    sqrtPrice: at(456).u128(),
    activationPoint: at(472).u64(),
    activationType: at(480).u8(),
    status: at(481).u8(),
    flagA: at(482).u8(),
    flagB: at(483).u8(),
    collectFeeMode: at(484).u8(),
    feeVersion: at(486).u8(),
    reserveA: at(680).u64(),
    reserveB: at(688).u64(),
  };
}

const flagProgram = (flag: number) =>
  flag === 0 ? TOKEN_PROGRAM : flag === 1 ? TOKEN_2022_PROGRAM : null;

/** Slot or Unix time, as the pool's activation counts. */
const pointOf = (v: MeteoraDammVenue) => (v.activationType === 0 ? v.clock.slot : v.clock.unixTime);

/** Whether `side` puts token A into the pool. */
const aIn = (v: MeteoraDammVenue, side: Side) => (side === 'sell') === v.coinIsA;

function baseFeeOf(v: MeteoraDammVenue, input: bigint, aToB: boolean): bigint {
  const f = v.baseFee;
  const point = pointOf(v);
  const early = point < v.activationPoint;
  switch (f.kind) {
    case 'time': {
      if (f.frequency === 0n) return f.cliff;
      const passed = early ? f.periods : (point - v.activationPoint) / f.frequency;
      const period = passed < f.periods ? passed : f.periods;
      return scheduledFee(f.exponential, f.cliff, f.reduction, period, true);
    }
    case 'limiter': {
      const zero =
        f.reference === 0n && f.duration === 0n && f.maxFeeBps === 0n && f.incrementBps === 0n;
      const applied = !zero && !aToB && !early && point <= v.activationPoint + f.duration;
      if (!applied) return f.cliff;
      return rateLimitedFee(input, f.cliff, f.reference, f.incrementBps, bpsNumerator(f.maxFeeBps));
    }
    case 'mcap': {
      let period = f.periods;
      if (!early && point <= v.activationPoint + f.expiration && v.sqrtPrice > v.initSqrtPrice) {
        if (v.initSqrtPrice === 0n || f.stepBps === 0n) refuse();
        const passed = ((v.sqrtPrice - v.initSqrtPrice) * 10_000n) / v.initSqrtPrice / f.stepBps;
        if (passed < period) period = passed;
      } else if (!early && point <= v.activationPoint + f.expiration) period = 0n;
      return scheduledFee(f.exponential, f.cliff, f.reduction, period, true);
    }
  }
}

/** What the pool's curve pays out for `amountIn` going in, before any output fee. */
function curveOut(v: MeteoraDammVenue, amountIn: bigint, aToB: boolean): bigint {
  if (v.collectFeeMode === COMPOUNDING) {
    const [inR, outR] = aToB ? [v.reserveA, v.reserveB] : [v.reserveB, v.reserveA];
    return fitU64((outR * amountIn) / fitU64(inR + amountIn));
  }
  const next = nextSqrtFromInput(v.sqrtPrice, v.liquidity, amountIn, aToB);
  if (aToB ? next < v.sqrtMinPrice : next > v.sqrtMaxPrice) refuse();
  return fitU64(
    aToB
      ? deltaQuote(next, v.sqrtPrice, v.liquidity, false)
      : deltaBase(v.sqrtPrice, next, v.liquidity, false),
  );
}

export const meteoraDamm: DexModule<MeteoraDammVenue> = {
  dex: 'meteora-damm',
  program: METEORA_DAMM_PROGRAM,
  units: 150_000,

  async load(ctx, pool, mint) {
    const [poolAcc = null, clockAcc = null] = await ctx.read([pool, SYSVAR_CLOCK]);
    if (poolAcc?.owner !== METEORA_DAMM_PROGRAM) return null;
    const s = decodeDammPool(poolAcc.data);
    const clock = clockAcc ? decodeClock(clockAcc.data) : null;
    if (!s?.baseFee || !clock) return null;
    const coinIsA = s.mintA === mint;
    if (!coinIsA && s.mintB !== mint) return null;
    if (flagProgram(coinIsA ? s.flagA : s.flagB) !== ctx.coinProgram) return null;
    const quote = await ctx.quoteAsset(coinIsA ? s.mintB : s.mintA);
    if (!quote || quote.program !== flagProgram(coinIsA ? s.flagB : s.flagA)) return null;
    const maxFee = MAX_FEE[s.feeVersion];
    if (maxFee === undefined || s.collectFeeMode > COMPOUNDING) return null;
    return {
      kind: 'dex',
      dex: 'meteora-damm',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      coinIsA,
      vaultA: s.vaultA,
      vaultB: s.vaultB,
      status: s.status,
      activationType: s.activationType,
      activationPoint: s.activationPoint,
      clock,
      collectFeeMode: s.collectFeeMode,
      maxFee,
      baseFee: s.baseFee,
      volatility: s.volatility,
      initSqrtPrice: s.initSqrtPrice,
      sqrtPrice: s.sqrtPrice,
      sqrtMinPrice: s.sqrtMinPrice,
      sqrtMaxPrice: s.sqrtMaxPrice,
      liquidity: s.liquidity,
      reserveA: s.reserveA,
      reserveB: s.reserveB,
    };
  },

  coinOf(data) {
    const s = decodeDammPool(data);
    return s ? coinOfPair(s.mintA, s.mintB) : null;
  },

  label: () => 'Meteora DAMM v2',

  quote(v, side, amountIn) {
    return quoteOrZero(() => {
      if (amountIn <= 0n || amountIn > U64_MAX) return 0n;
      const aToB = aIn(v, side);
      const vol = v.volatility;
      const total =
        baseFeeOf(v, amountIn, aToB) +
        (vol ? volatilityFee(vol.accumulator, vol.binStep, vol.control) : 0n);
      const fee = fitU64(total) < v.maxFee ? total : v.maxFee;
      // Fees come off the input only when token B goes in on a pool that collects in B.
      if (v.collectFeeMode !== 0 && !aToB)
        return curveOut(v, amountIn - feeOn(amountIn, fee), aToB);
      const out = curveOut(v, amountIn, aToB);
      return out - feeOn(out, fee);
    });
  },

  spot(v) {
    const price =
      v.collectFeeMode === COMPOUNDING
        ? v.reserveA > 0n
          ? Number(v.reserveB) / Number(v.reserveA)
          : 0
        : (Number(v.sqrtPrice) / Number(ONE_Q64)) ** 2;
    return v.coinIsA ? price : price > 0 ? 1 / price : 0;
  },

  idle(v) {
    if (v.status !== 0) return 'Meteora has disabled swaps on this pool.';
    if (pointOf(v) < v.activationPoint) return 'This Meteora pool has not opened yet.';
    return null;
  },

  swap(v, side, user, amountIn, minOut) {
    const { source, destination } = userAccounts(v, side, user);
    const coin = { mint: v.mint, program: v.tokenProgram };
    const quote = { mint: v.quote.mint, program: v.quote.program };
    const [a, b] = v.coinIsA ? [coin, quote] : [quote, coin];
    return {
      programId: METEORA_DAMM_PROGRAM,
      keys: [
        meta(AUTHORITY),
        meta(v.pool, true),
        meta(source, true),
        meta(destination, true),
        meta(v.vaultA, true),
        meta(v.vaultB, true),
        meta(a.mint),
        meta(b.mint),
        meta(user, false, true),
        meta(a.program),
        meta(b.program),
        // No referral account: the program's own address stands in for none.
        meta(METEORA_DAMM_PROGRAM),
        meta(EVENT_AUTHORITY),
        meta(METEORA_DAMM_PROGRAM),
        // A rate-limited pool checks the transaction holds no other swap on it.
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
