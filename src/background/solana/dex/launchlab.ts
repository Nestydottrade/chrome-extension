import type { SolAddress } from '../../../shared/solana';
import {
  SYSTEM_PROGRAM,
  USD1_MINT,
  WSOL_MINT,
  associatedTokenAddress,
  coinOfPair,
  findProgramAddress,
  seed,
} from '../address';
import { Reader, hasDiscriminator } from '../layouts';
import { concat, meta, u64, type Instruction } from '../tx';
import type { DexModule, DexVenueBase } from './types';

/**
 * Raydium LaunchLab, the bonding curves behind Bonk.fun and other launch sites. Facts from
 * Raydium's SDK (raydium-sdk-V2, launchpad): a curve sells its coin for one quote token
 * (wrapped SOL or a stablecoin) on a constant-product, fixed-price or linear curve; the
 * protocol, platform and creator fees are taken from the quote side, rounded up; a buy past
 * what is left for sale fills only that, and charges only for it.
 */
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const AUTHORITY = findProgramAddress([seed('vault_auth_seed')], LAUNCHLAB_PROGRAM);
const EVENT_AUTHORITY = findProgramAddress([seed('__event_authority')], LAUNCHLAB_PROGRAM);

const POOL_DISC = [247, 237, 227, 245, 215, 195, 222, 70];
const CONFIG_DISC = [149, 8, 156, 202, 160, 252, 176, 217];
const PLATFORM_DISC = [160, 78, 128, 0, 248, 83, 230, 160];
const BUY_EXACT_IN = [250, 234, 13, 123, 213, 156, 19, 236];
const SELL_EXACT_IN = [149, 39, 222, 155, 211, 124, 152, 26];
/** Fee rates are in millionths. */
const RATE = 1_000_000n;
const Q64 = 1n << 64n;
/** Pool status while its curve sells; later ones are migrating, then migrated. */
const FUNDING = 0;

/** The curve's shape, from its config. */
type CurveType = 0 | 1 | 2;

export interface LaunchLabVenue extends DexVenueBase<'launchlab'> {
  config: SolAddress;
  platform: SolAddress;
  creator: SolAddress;
  vaultA: SolAddress;
  vaultB: SolAddress;
  status: number;
  curve: CurveType;
  virtualA: bigint;
  virtualB: bigint;
  /** Coin sold so far, and quote paid in (fees excluded). */
  realA: bigint;
  realB: bigint;
  /** What the curve sells before it completes. */
  totalSellA: bigint;
  /** Protocol, platform and creator fee rates, together. */
  feeRate: bigint;
}

interface PoolState {
  status: number;
  virtualA: bigint;
  virtualB: bigint;
  realA: bigint;
  realB: bigint;
  totalSellA: bigint;
  config: SolAddress;
  platform: SolAddress;
  mintA: SolAddress;
  mintB: SolAddress;
  vaultA: SolAddress;
  vaultB: SolAddress;
  creator: SolAddress;
}

/** PoolState: borsh, fixed offsets after the discriminator. */
export function decodeLaunchPool(data: Uint8Array): PoolState | null {
  if (data.length < 367 || !hasDiscriminator(data, POOL_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    status: at(17).u8(),
    totalSellA: at(29).u64(),
    virtualA: at(37).u64(),
    virtualB: at(45).u64(),
    realA: at(53).u64(),
    realB: at(61).u64(),
    config: at(141).pubkey(),
    platform: at(173).pubkey(),
    mintA: at(205).pubkey(),
    mintB: at(237).pubkey(),
    vaultA: at(269).pubkey(),
    vaultB: at(301).pubkey(),
    creator: at(333).pubkey(),
  };
}

const ceilRate = (amount: bigint, rate: bigint) => (amount * rate + RATE - 1n) / RATE;

/** Largest integer whose square is at most `n`. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/** The coin a net quote amount buys on the curve, before the cap on what is left. */
function curveBuy(v: LaunchLabVenue, net: bigint): bigint {
  switch (v.curve) {
    case 0: {
      const inR = v.virtualB + v.realB;
      return (net * (v.virtualA - v.realA)) / (inR + net);
    }
    case 1:
      return v.virtualB > 0n ? (v.virtualA * net) / v.virtualB : 0n;
    case 2:
      return v.virtualA > 0n ? isqrt((2n * (v.realB + net) * Q64) / v.virtualA) - v.realA : 0n;
  }
}

/** The quote selling `a` of the coin takes out of the curve, before fees. */
function curveSell(v: LaunchLabVenue, a: bigint): bigint {
  switch (v.curve) {
    case 0: {
      const inR = v.virtualA - v.realA;
      return (a * (v.virtualB + v.realB)) / (inR + a);
    }
    case 1:
      return v.virtualA > 0n ? (v.virtualB * a) / v.virtualA : 0n;
    case 2: {
      if (a > v.realA) return 0n;
      const left = v.realA - a;
      const quote = (v.virtualA * left * left + 2n * Q64 - 1n) / (2n * Q64);
      return v.realB - quote;
    }
  }
}

const poolAddress = (mintA: SolAddress, mintB: SolAddress) =>
  findProgramAddress([seed('pool'), mintA, mintB], LAUNCHLAB_PROGRAM);

/** Pools read before: their keys never change, so later reads take the rest along. */
const known = new Map<SolAddress, PoolState>();

export const launchLab: DexModule<LaunchLabVenue> = {
  dex: 'launchlab',
  program: LAUNCHLAB_PROGRAM,
  units: 200_000,

  // A coin's curve is found from its mint: one per quote token it may sell for.
  candidates: (mint) => [poolAddress(mint, WSOL_MINT), poolAddress(mint, USD1_MINT)],

  async load(ctx, pool, mint) {
    const before = known.get(pool);
    const accs = await ctx.read(
      before ? [pool, before.config, before.platform, before.vaultA, before.vaultB] : [pool],
    );
    const poolAcc = accs[0] ?? null;
    let rest = accs.slice(1);
    if (poolAcc?.owner !== LAUNCHLAB_PROGRAM) return null;
    const s = decodeLaunchPool(poolAcc.data);
    if (!s || s.mintA !== mint) return null;
    if (
      before?.config !== s.config ||
      before.platform !== s.platform ||
      before.vaultA !== s.vaultA ||
      before.vaultB !== s.vaultB
    ) {
      rest = await ctx.read([s.config, s.platform, s.vaultA, s.vaultB]);
    }
    const [cfgAcc, platAcc] = rest;
    const quote = await ctx.quoteAsset(s.mintB);
    if (!quote) return null;
    if (
      !cfgAcc ||
      cfgAcc.owner !== LAUNCHLAB_PROGRAM ||
      !hasDiscriminator(cfgAcc.data, CONFIG_DISC)
    )
      return null;
    if (
      !platAcc ||
      platAcc.owner !== LAUNCHLAB_PROGRAM ||
      !hasDiscriminator(platAcc.data, PLATFORM_DISC)
    )
      return null;
    const curve = new Reader(cfgAcc.data, 16).u8();
    if (curve !== 0 && curve !== 1 && curve !== 2) return null;
    const tradeFeeRate = new Reader(cfgAcc.data, 27).u64();
    const platformFeeRate = new Reader(platAcc.data, 104).u64();
    const creatorFeeRate = new Reader(platAcc.data, 720).u64();
    const feeRate = tradeFeeRate + platformFeeRate + creatorFeeRate;
    if (feeRate >= RATE) return null;
    if (known.size > 200) known.clear();
    known.set(pool, s);
    return {
      kind: 'dex',
      dex: 'launchlab',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      config: s.config,
      platform: s.platform,
      creator: s.creator,
      vaultA: s.vaultA,
      vaultB: s.vaultB,
      status: s.status,
      curve,
      virtualA: s.virtualA,
      virtualB: s.virtualB,
      realA: s.realA,
      realB: s.realB,
      totalSellA: s.totalSellA,
      feeRate,
    };
  },

  coinOf(data) {
    const s = decodeLaunchPool(data);
    return s ? coinOfPair(s.mintA, s.mintB) : null;
  },

  label: () => 'LaunchLab',

  quote(v, side, amountIn) {
    if (amountIn <= 0n || v.status !== FUNDING) return 0n;
    if (side === 'buy') {
      const net = amountIn - ceilRate(amountIn, v.feeRate);
      if (net <= 0n) return 0n;
      const out = curveBuy(v, net);
      const left = v.totalSellA - v.realA;
      return out <= 0n ? 0n : out > left ? left : out;
    }
    const gross = curveSell(v, amountIn);
    if (gross <= 0n || gross > v.realB) return 0n;
    const out = gross - ceilRate(gross, v.feeRate);
    return out > 0n ? out : 0n;
  },

  spot(v) {
    switch (v.curve) {
      case 0: {
        const coin = v.virtualA - v.realA;
        return coin > 0n ? Number(v.virtualB + v.realB) / Number(coin) : 0;
      }
      case 1:
        return v.virtualA > 0n ? Number(v.virtualB) / Number(v.virtualA) : 0;
      case 2:
        return Number(v.virtualA * v.realA) / Number(Q64);
    }
  },

  idle(v) {
    return v.status === FUNDING
      ? null
      : 'This LaunchLab curve is complete. Trading moves to Raydium once it migrates.';
  },

  swap(v, side, user, amountIn, minOut) {
    const coinAta = associatedTokenAddress(user, v.mint, v.tokenProgram);
    const quoteAta = associatedTokenAddress(user, v.quote.mint, v.quote.program);
    return {
      programId: LAUNCHLAB_PROGRAM,
      keys: [
        meta(user, true, true),
        meta(AUTHORITY),
        meta(v.config),
        meta(v.platform),
        meta(v.pool, true),
        meta(coinAta, true),
        meta(quoteAta, true),
        meta(v.vaultA, true),
        meta(v.vaultB, true),
        meta(v.mint),
        meta(v.quote.mint),
        meta(v.tokenProgram),
        meta(v.quote.program),
        meta(EVENT_AUTHORITY),
        meta(LAUNCHLAB_PROGRAM),
        meta(SYSTEM_PROGRAM),
        // Where the platform's and the creator's fees accrue.
        meta(findProgramAddress([v.platform, v.quote.mint], LAUNCHLAB_PROGRAM), true),
        meta(findProgramAddress([v.creator, v.quote.mint], LAUNCHLAB_PROGRAM), true),
      ],
      // The amount, the minimum back, and no share fee.
      data: concat(
        side === 'buy' ? BUY_EXACT_IN : SELL_EXACT_IN,
        u64(amountIn),
        u64(minOut),
        u64(0n),
      ),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 32) return null;
    if (!hasDiscriminator(data, BUY_EXACT_IN) && !hasDiscriminator(data, SELL_EXACT_IN))
      return null;
    const r = new Reader(data, 8);
    return { amountIn: r.u64(), minOut: r.u64() };
  },
};
