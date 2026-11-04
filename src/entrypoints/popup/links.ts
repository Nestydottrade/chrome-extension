import { getChain } from '../../shared/chains';
import { txUrl as explorerTx } from '../../shared/networks';
import { isSolana } from '../../shared/solana';

/** GMGN path slugs for the chains it lists; others open on DEX Screener. */
const GMGN: Record<number, string> = { 1: 'eth', 56: 'bsc', 8453: 'base', 4663: 'robinhood' };
const GMGN_SOLANA = 'sol';

export function chartUrl(chainId: number, token: string): string {
  const slug = isSolana(chainId) ? GMGN_SOLANA : GMGN[chainId];
  if (slug) return `https://gmgn.ai/${slug}/token/${token}`;
  return `https://dexscreener.com/${getChain(chainId)?.dexscreenerSlug ?? 'ethereum'}/${token}`;
}

export function txUrl(chainId: number, hash: string): string {
  return explorerTx(chainId, hash);
}
