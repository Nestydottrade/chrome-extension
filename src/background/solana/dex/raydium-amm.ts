import type { SolAddress } from '../../../shared/solana';
import { TOKEN_PROGRAM, coinOfPair, findProgramAddressWithBump, seed } from '../address';
import { Reader, decodeTokenAccount } from '../layouts';
import type { Side } from '../pump';
import { concat, meta, u64, type Instruction } from '../tx';
import type { DexModule, DexVenueBase } from './types';
import { userAccounts } from './accounts';

/**
 * Raydium's constant-product AMM (v4), where pump.fun coins went before PumpSwap existed.
 * Facts from its source (raydium-io/raydium-amm): `SwapBaseInV2` (tag 16) swaps without
 * the order book, prices on the vaults less the profit the pool has yet to take, takes its
 * fee from the input rounded up, and trades SPL Token mints only.
 */
export const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const [AUTHORITY, AUTHORITY_NONCE] = findProgramAddressWithBump(
  [seed('amm authority')],
  RAYDIUM_AMM_PROGRAM,
);
export const RAYDIUM_AMM_AUTHORITY = AUTHORITY;

const POOL_SIZE = 752;
const SWAP_BASE_IN_V2 = 16;

/** Statuses that allow swaps: Initialized, SwapOnly, and WaitingTrade once it opens. */
const SWAP_STATUSES = new Set([1n, 6n, 7n]);
const WAITING_TRADE = 7n;

export interface RaydiumAmmVenue extends DexVenueBase<'raydium-amm'> {
  /** Whether the coin is the pool's "coin" side (else its "pc" side). */
  coinIsMint: boolean;
  status: bigint;
  openTime: bigint;
  feeNumerator: bigint;
  feeDenominator: bigint;
  coinVault: SolAddress;
  pcVault: SolAddress;
  /** The vaults less the profit the pool has yet to take: what swaps price on. */
  coinReserve: bigint;
  pcReserve: bigint;
}

interface PoolState {
  status: bigint;
  nonce: bigint;
  feeNumerator: bigint;
  feeDenominator: bigint;
  pnlCoin: bigint;
  pnlPc: bigint;
  openTime: bigint;
  coinVault: SolAddress;
  pcVault: SolAddress;
  coinMint: SolAddress;
  pcMint: SolAddress;
}

/** AmmInfo: no discriminator, fixed offsets (u64s, then the fees, state data and keys). */
export function decodeAmmInfo(data: Uint8Array): PoolState | null {
  if (data.length !== POOL_SIZE) return null;
  const at = (o: number) => new Reader(data, o);
  return {
    status: at(0).u64(),
    nonce: at(8).u64(),
    feeNumerator: at(176).u64(),
    feeDenominator: at(184).u64(),
    pnlCoin: at(192).u64(),
    pnlPc: at(200).u64(),
    openTime: at(224).u64(),
    coinVault: at(336).pubkey(),
    pcVault: at(368).pubkey(),
    coinMint: at(400).pubkey(),
    pcMint: at(432).pubkey(),
  };
}

/** Pools read before: their keys never change, so later reads take the vaults along. */
const known = new Map<SolAddress, PoolState>();

function reserves(v: RaydiumAmmVenue, side: Side): { inR: bigint; outR: bigint } {
  // Buying spends the quote side; the coin is "coin" or "pc" depending on the pool.
  const coinIn = side === 'buy' ? !v.coinIsMint : v.coinIsMint;
  return coinIn
    ? { inR: v.coinReserve, outR: v.pcReserve }
    : { inR: v.pcReserve, outR: v.coinReserve };
}

export const raydiumAmm: DexModule<RaydiumAmmVenue> = {
  dex: 'raydium-amm',
  program: RAYDIUM_AMM_PROGRAM,
  units: 90_000,

  async load(ctx, pool, mint) {
    // The coin must be an SPL Token mint: the program refuses Token-2022.
    if (ctx.coinProgram !== TOKEN_PROGRAM) return null;
    const before = known.get(pool);
    const accs = await ctx.read(before ? [pool, before.coinVault, before.pcVault] : [pool]);
    const poolAcc = accs[0] ?? null;
    let [coinAcc, pcAcc] = [accs[1] ?? null, accs[2] ?? null];
    if (!poolAcc || poolAcc.owner !== RAYDIUM_AMM_PROGRAM) return null;
    const state = decodeAmmInfo(poolAcc.data);
    if (!state || state.nonce !== BigInt(AUTHORITY_NONCE)) return null;
    if (before?.coinVault !== state.coinVault || before.pcVault !== state.pcVault) {
      [coinAcc = null, pcAcc = null] = await ctx.read([state.coinVault, state.pcVault]);
    }
    const coinIsMint = state.coinMint === mint;
    if (!coinIsMint && state.pcMint !== mint) return null;
    const quote = await ctx.quoteAsset(coinIsMint ? state.pcMint : state.coinMint);
    if (!quote || quote.program !== TOKEN_PROGRAM) return null;
    const coinVault = coinAcc ? decodeTokenAccount(coinAcc.data) : null;
    const pcVault = pcAcc ? decodeTokenAccount(pcAcc.data) : null;
    if (!coinVault || !pcVault) return null;
    if (coinVault.amount < state.pnlCoin || pcVault.amount < state.pnlPc) return null;
    if (known.size > 200) known.clear();
    known.set(pool, state);
    return {
      kind: 'dex',
      dex: 'raydium-amm',
      pool,
      mint,
      tokenProgram: TOKEN_PROGRAM,
      quote,
      coinIsMint,
      status: state.status,
      openTime: state.openTime,
      feeNumerator: state.feeNumerator,
      feeDenominator: state.feeDenominator,
      coinVault: state.coinVault,
      pcVault: state.pcVault,
      coinReserve: coinVault.amount - state.pnlCoin,
      pcReserve: pcVault.amount - state.pnlPc,
    };
  },

  coinOf(data) {
    const s = decodeAmmInfo(data);
    return s ? coinOfPair(s.coinMint, s.pcMint) : null;
  },

  label: () => 'Raydium AMM',

  quote(v, side, amountIn) {
    if (amountIn <= 0n || v.feeDenominator === 0n) return 0n;
    const { inR, outR } = reserves(v, side);
    // The fee is rounded up, then the rest swaps at constant product, rounded down.
    const fee = (amountIn * v.feeNumerator + v.feeDenominator - 1n) / v.feeDenominator;
    const net = amountIn - fee;
    if (net <= 0n) return 0n;
    const out = (outR * net) / (inR + net);
    return out > 0n && out < outR ? out : 0n;
  },

  spot(v) {
    const [coin, quote] = v.coinIsMint
      ? [v.coinReserve, v.pcReserve]
      : [v.pcReserve, v.coinReserve];
    return coin > 0n ? Number(quote) / Number(coin) : 0;
  },

  idle(v, nowSec) {
    if (!SWAP_STATUSES.has(v.status)) return 'Raydium has paused this pool.';
    if (v.status === WAITING_TRADE && BigInt(Math.floor(nowSec)) < v.openTime)
      return 'This Raydium pool has not opened yet.';
    return null;
  },

  swap(v, side, user, amountIn, minOut) {
    const { source, destination } = userAccounts(v, side, user);
    return {
      programId: RAYDIUM_AMM_PROGRAM,
      keys: [
        meta(TOKEN_PROGRAM),
        meta(v.pool, true),
        meta(RAYDIUM_AMM_AUTHORITY),
        meta(v.coinVault, true),
        meta(v.pcVault, true),
        meta(source, true),
        meta(destination, true),
        meta(user, false, true),
      ],
      data: concat([SWAP_BASE_IN_V2], u64(amountIn), u64(minOut)),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 17 || data[0] !== SWAP_BASE_IN_V2) return null;
    const r = new Reader(data, 1);
    return { amountIn: r.u64(), minOut: r.u64() };
  },
};
