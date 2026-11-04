import { base58 } from '@scure/base';
import { z } from 'zod';

/**
 * Solana's chain id in tickets, history and settings: the id Relay uses for it, so the
 * numeric chain ids everything else is keyed by stay unique. It is not an EVM chain:
 * `getChain` never returns it, and EVM requests refuse it.
 */
export const SOLANA_CHAIN_ID = 792703809;

export const SOLANA = {
  id: SOLANA_CHAIN_ID,
  key: 'solana',
  name: 'Solana',
  shortName: 'SOL',
  /** URL slugs terminals use for Solana. */
  aliases: ['solana', 'sol'],
  nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
  explorer: { name: 'Solscan', url: 'https://solscan.io' },
  /**
   * Public endpoint, tried after the user's own RPC. Rate-limited, and it refuses indexed
   * reads (a wallet's token accounts). api.mainnet-beta.solana.com is not listed: it
   * refuses every request that carries an Origin, which an extension's always do.
   */
  rpcUrls: ['https://solana-rpc.publicnode.com'],
  quickBuyAmounts: ['0.05', '0.1', '0.25', '0.5'],
} as const;

export function isSolana(chainId: number | undefined | null): boolean {
  return chainId === SOLANA_CHAIN_ID;
}

/** Decimals of a chain's native coin: 9 for SOL, 18 for every EVM chain Nesty supports. */
export function nativeDecimals(chainId: number): number {
  return isSolana(chainId) ? SOLANA.nativeCurrency.decimals : 18;
}

/** A base58 Solana address (32 bytes). Case matters: never lowercase one. */
export type SolAddress = string;

export function isSolAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export const SolAddressSchema = z.string().refine(isSolAddress, 'invalid address');

export function solscanAccountUrl(address: string): string {
  return `${SOLANA.explorer.url}/account/${address}`;
}

export function solscanTokenUrl(mint: string): string {
  return `${SOLANA.explorer.url}/token/${mint}`;
}
