import type { SolAddress } from '../../../shared/solana';
import { associatedTokenAddress } from '../address';
import type { Side } from '../pump';
import type { DexVenueBase } from './types';

/** The wallet's own token accounts a swap moves between: the quote's and the coin's. */
export function userAccounts(
  v: DexVenueBase,
  side: Side,
  user: SolAddress,
): { source: SolAddress; destination: SolAddress } {
  const coin = associatedTokenAddress(user, v.mint, v.tokenProgram);
  const quote = associatedTokenAddress(user, v.quote.mint, v.quote.program);
  return side === 'buy'
    ? { source: quote, destination: coin }
    : { source: coin, destination: quote };
}
