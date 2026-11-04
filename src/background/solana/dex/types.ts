import type { SolAddress } from '../../../shared/solana';
import type { QuoteAsset, Side } from '../pump';
import type { AccountInfo } from '../rpc';
import type { Instruction } from '../tx';

/** The pool programs Nesty trades on besides pump.fun's own. */
export type DexKind =
  | 'raydium-amm'
  | 'raydium-cpmm'
  | 'launchlab'
  | 'meteora-damm'
  | 'meteora-dbc'
  | 'meteora-dlmm'
  | 'orca';

/**
 * A pool of `mint` against `quote` (wrapped SOL or a dollar stablecoin), as read from
 * chain. Each program adds the state its quotes and swaps need.
 */
export interface DexVenueBase<K extends DexKind = DexKind> {
  kind: 'dex';
  dex: K;
  pool: SolAddress;
  /** The coin, and the token program it lives under. */
  mint: SolAddress;
  tokenProgram: SolAddress;
  /** What the coin is priced in, and paid with, in this pool. */
  quote: QuoteAsset;
}

/** What reading a pool needs besides its address. */
export interface DexLoadCtx {
  /** Accounts, read together with the other pools' reads of the moment. */
  read(keys: readonly SolAddress[]): Promise<(AccountInfo | null)[]>;
  /** The coin's token program, from its mint. */
  coinProgram: SolAddress;
  /** A quote mint the pool may pay in (wrapped SOL, a stablecoin), else null. */
  quoteAsset(mint: SolAddress): Promise<QuoteAsset | null>;
}

/**
 * One pool program: reading its pools, quoting them exactly as the program will pay, and
 * the one swap instruction Nesty builds for it. The validator rebuilds that instruction
 * from the amounts in a call's data and accepts only an exact match.
 */
export interface DexModule<V extends DexVenueBase> {
  readonly dex: V['dex'];
  readonly program: SolAddress;
  /** Compute a trade on it asks for before a simulation measures it, accounts included. */
  readonly units: number;
  /** ...where that grows with the trade (bins it crosses): the compute of this one. */
  unitsFor?(v: V, side: Side, amountIn: bigint): number;
  /** Pools of `mint` found from its address alone (program-derived), to read and check. */
  candidates?(mint: SolAddress): SolAddress[];
  /** The pool at `pool`, or null unless it is this program's pool of `mint` and a quote. */
  load(ctx: DexLoadCtx, pool: SolAddress, mint: SolAddress): Promise<V | null>;
  /** The coin a pool account of this program trades, or null when it is none. */
  coinOf(data: Uint8Array): SolAddress | null;
  label(v: V): string;
  /** What the program pays for `amountIn`, fees included; 0 when it cannot fill it. */
  quote(v: V, side: Side, amountIn: bigint): bigint;
  /** Raw quote units per raw coin unit, before fees. */
  spot(v: V): number;
  /** Why the pool cannot trade at `nowSec` (paused, not open yet), or null. */
  idle(v: V, nowSec: number): string | null;
  /** The program call: `amountIn` of what `side` spends, at least `minOut` back. */
  swap(v: V, side: Side, user: SolAddress, amountIn: bigint, minOut: bigint): Instruction;
  /** The amounts a call's data names, or null when it is not the swap `swap` builds. */
  amounts(data: Uint8Array): { amountIn: bigint; minOut: bigint } | null;
}
