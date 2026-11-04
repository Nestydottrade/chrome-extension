import type { SolAddress } from '../../../shared/solana';
import { coinOfPair, findProgramAddress, seed } from '../address';
import { Reader, decodeTokenAccount, hasDiscriminator } from '../layouts';
import type { Side } from '../pump';
import { concat, meta, u64, type Instruction } from '../tx';
import { userAccounts } from './accounts';
import type { DexModule, DexVenueBase } from './types';

/**
 * Raydium's constant-product pools (CPMM), where Raydium LaunchLab coins graduate. Facts
 * from its source (raydium-io/raydium-cp-swap): `swap_base_input` prices on the vaults
 * less the fees owed out of them, takes the trade fee from the input rounded up, and a
 * creator fee (when the pool enables it) from the input or the output as the pool says.
 */
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const RAYDIUM_CPMM_AUTHORITY = findProgramAddress(
  [seed('vault_and_lp_mint_auth_seed')],
  RAYDIUM_CPMM_PROGRAM,
);

const POOL_DISC = [247, 237, 227, 245, 215, 195, 222, 70];
const CONFIG_DISC = [218, 244, 33, 104, 203, 203, 43, 111];
const SWAP_BASE_INPUT = [143, 190, 90, 218, 196, 30, 51, 222];
const POOL_SIZE = 637;
/** Fee rates are in millionths. */
const RATE = 1_000_000n;
/** Status bit 2 set: swaps disabled. */
const SWAP_DISABLED = 4;

export interface RaydiumCpmmVenue extends DexVenueBase<'raydium-cpmm'> {
  /** Whether the coin is the pool's token 0 (else token 1). */
  coinIs0: boolean;
  config: SolAddress;
  observation: SolAddress;
  vault0: SolAddress;
  vault1: SolAddress;
  status: number;
  openTime: bigint;
  /** The vaults less the fees owed out of them: what swaps price on. */
  reserve0: bigint;
  reserve1: bigint;
  tradeFeeRate: bigint;
  /** 0 unless the pool takes a creator fee. */
  creatorFeeRate: bigint;
  /** 0: on the input, 1: only in token 0, 2: only in token 1. */
  creatorFeeOn: number;
}

interface PoolState {
  config: SolAddress;
  vault0: SolAddress;
  vault1: SolAddress;
  mint0: SolAddress;
  mint1: SolAddress;
  program0: SolAddress;
  program1: SolAddress;
  observation: SolAddress;
  status: number;
  /** Protocol, fund and creator fees owed out of each vault. */
  owed0: bigint;
  owed1: bigint;
  openTime: bigint;
  creatorFeeOn: number;
  creatorFeeEnabled: boolean;
}

/** PoolState: zero-copy and packed, at fixed offsets after the discriminator. */
export function decodeCpmmPool(data: Uint8Array): PoolState | null {
  if (data.length !== POOL_SIZE || !hasDiscriminator(data, POOL_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  // Protocol fees of tokens 0 and 1, then fund fees, then (later) creator fees.
  const owed = (protocol: number, fund: number, creator: number) =>
    at(protocol).u64() + at(fund).u64() + at(creator).u64();
  return {
    config: at(8).pubkey(),
    vault0: at(72).pubkey(),
    vault1: at(104).pubkey(),
    mint0: at(168).pubkey(),
    mint1: at(200).pubkey(),
    program0: at(232).pubkey(),
    program1: at(264).pubkey(),
    observation: at(296).pubkey(),
    status: at(329).u8(),
    owed0: owed(341, 357, 397),
    owed1: owed(349, 365, 405),
    openTime: at(373).u64(),
    creatorFeeOn: at(389).u8(),
    creatorFeeEnabled: at(390).bool(),
  };
}

/** AmmConfig: the trade fee and the creator fee rates. */
function decodeConfig(data: Uint8Array): { tradeFeeRate: bigint; creatorFeeRate: bigint } | null {
  if (!hasDiscriminator(data, CONFIG_DISC)) return null;
  return { tradeFeeRate: new Reader(data, 12).u64(), creatorFeeRate: new Reader(data, 108).u64() };
}

/** Pools read before: their keys never change, so later reads take the rest along. */
const known = new Map<SolAddress, PoolState>();

const ceilRate = (amount: bigint, rate: bigint) => (amount * rate + RATE - 1n) / RATE;

/** Whether `side` puts token 0 into the pool. */
const zeroIn = (v: RaydiumCpmmVenue, side: Side) => (side === 'sell') === v.coinIs0;

export const raydiumCpmm: DexModule<RaydiumCpmmVenue> = {
  dex: 'raydium-cpmm',
  program: RAYDIUM_CPMM_PROGRAM,
  units: 150_000,

  async load(ctx, pool, mint) {
    const before = known.get(pool);
    const accs = await ctx.read(
      before ? [pool, before.config, before.vault0, before.vault1] : [pool],
    );
    const poolAcc = accs[0] ?? null;
    let [cfgAcc = null, acc0 = null, acc1 = null] = accs.slice(1);
    if (poolAcc?.owner !== RAYDIUM_CPMM_PROGRAM) return null;
    const s = decodeCpmmPool(poolAcc.data);
    if (!s) return null;
    if (before?.config !== s.config || before.vault0 !== s.vault0 || before.vault1 !== s.vault1) {
      [cfgAcc = null, acc0 = null, acc1 = null] = await ctx.read([s.config, s.vault0, s.vault1]);
    }
    const coinIs0 = s.mint0 === mint;
    if (!coinIs0 && s.mint1 !== mint) return null;
    if ((coinIs0 ? s.program0 : s.program1) !== ctx.coinProgram) return null;
    const quote = await ctx.quoteAsset(coinIs0 ? s.mint1 : s.mint0);
    if (!quote || quote.program !== (coinIs0 ? s.program1 : s.program0)) return null;
    const cfg = cfgAcc?.owner === RAYDIUM_CPMM_PROGRAM ? decodeConfig(cfgAcc.data) : null;
    const v0 = acc0 ? decodeTokenAccount(acc0.data) : null;
    const v1 = acc1 ? decodeTokenAccount(acc1.data) : null;
    if (!cfg || !v0 || !v1 || v0.amount < s.owed0 || v1.amount < s.owed1) return null;
    if (known.size > 200) known.clear();
    known.set(pool, s);
    return {
      kind: 'dex',
      dex: 'raydium-cpmm',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      coinIs0,
      config: s.config,
      observation: s.observation,
      vault0: s.vault0,
      vault1: s.vault1,
      status: s.status,
      openTime: s.openTime,
      reserve0: v0.amount - s.owed0,
      reserve1: v1.amount - s.owed1,
      tradeFeeRate: cfg.tradeFeeRate,
      creatorFeeRate: s.creatorFeeEnabled ? cfg.creatorFeeRate : 0n,
      creatorFeeOn: s.creatorFeeOn,
    };
  },

  coinOf(data) {
    const s = decodeCpmmPool(data);
    return s ? coinOfPair(s.mint0, s.mint1) : null;
  },

  label: () => 'Raydium CPMM',

  quote(v, side, amountIn) {
    const in0 = zeroIn(v, side);
    const [inR, outR] = in0 ? [v.reserve0, v.reserve1] : [v.reserve1, v.reserve0];
    if (amountIn <= 0n || inR === 0n || outR === 0n) return 0n;
    const onInput = v.creatorFeeOn === 0 || v.creatorFeeOn === (in0 ? 1 : 2);
    // The trade fee (with the creator's, when it is taken from the input) is rounded up.
    const fee = ceilRate(amountIn, v.tradeFeeRate + (onInput ? v.creatorFeeRate : 0n));
    if (fee >= amountIn) return 0n;
    const net = amountIn - fee;
    const swapped = (net * outR) / (inR + net);
    const out = onInput ? swapped : swapped - ceilRate(swapped, v.creatorFeeRate);
    return out > 0n ? out : 0n;
  },

  spot(v) {
    const [coin, quote] = v.coinIs0 ? [v.reserve0, v.reserve1] : [v.reserve1, v.reserve0];
    return coin > 0n ? Number(quote) / Number(coin) : 0;
  },

  idle(v, nowSec) {
    if (v.status & SWAP_DISABLED) return 'Raydium has paused swaps on this pool.';
    if (BigInt(Math.floor(nowSec)) < v.openTime) return 'This Raydium pool has not opened yet.';
    return null;
  },

  swap(v, side, user, amountIn, minOut) {
    const { source, destination } = userAccounts(v, side, user);
    const in0 = zeroIn(v, side);
    const coin = { mint: v.mint, program: v.tokenProgram };
    const quote = { mint: v.quote.mint, program: v.quote.program };
    const [t0, t1] = v.coinIs0 ? [coin, quote] : [quote, coin];
    const [tin, tout] = in0 ? [t0, t1] : [t1, t0];
    const [vin, vout] = in0 ? [v.vault0, v.vault1] : [v.vault1, v.vault0];
    return {
      programId: RAYDIUM_CPMM_PROGRAM,
      keys: [
        meta(user, false, true),
        meta(RAYDIUM_CPMM_AUTHORITY),
        meta(v.config),
        meta(v.pool, true),
        meta(source, true),
        meta(destination, true),
        meta(vin, true),
        meta(vout, true),
        meta(tin.program),
        meta(tout.program),
        meta(tin.mint),
        meta(tout.mint),
        meta(v.observation, true),
      ],
      data: concat(SWAP_BASE_INPUT, u64(amountIn), u64(minOut)),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 24 || !hasDiscriminator(data, SWAP_BASE_INPUT)) return null;
    const r = new Reader(data, 8);
    return { amountIn: r.u64(), minOut: r.u64() };
  },
};
