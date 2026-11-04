import type { Address, Hex } from 'viem';

/**
 * What a site adapter could read from the URL. It is only a hint: the background
 * re-checks everything on-chain before showing or trading anything.
 */
export interface Detection {
  siteId: string;
  /** 'token' = URL names the token; 'pair' = a pool/pair address; 'unknown' = could be either. */
  kind: 'token' | 'pair' | 'unknown';
  address?: Address;
  /** Uniswap v4 pool id (32 bytes) when the URL names a v4 pool. */
  poolId?: Hex;
  /** A Solana address (base58): a mint, or a pool or bonding curve (see `kind`). */
  solana?: string;
  chainId?: number;
}

interface TargetMeta {
  name: string;
  symbol: string;
  decimals: number;
  /** How the token was resolved, for display ("on-chain" vs "via DEX Screener"). */
  source: 'url' | 'pair' | 'api';
}

/** Result of on-chain resolution in the background: an EVM token. */
export interface EvmTarget extends TargetMeta {
  kind?: undefined;
  chainId: number;
  token: Address;
  /** Pool the URL pointed at, if any. */
  pair?: Address;
  poolId?: Hex;
}

/** A Solana token, by its mint. */
export interface SolanaTarget extends TargetMeta {
  kind: 'solana';
  chainId: number;
  /** Base58: compared exactly, never case-folded. */
  mint: string;
  /** The pool or curve the URL pointed at, if any. */
  pair?: string;
}

export type ResolvedTarget = EvmTarget | SolanaTarget;
