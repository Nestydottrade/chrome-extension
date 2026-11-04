import { chainLabel, getChain } from './chains';
import { SOLANA, isSolana } from './solana';

/**
 * Names, units and explorer links for any chain id Nesty knows: the EVM chains and
 * Solana. Solscan and the EVM explorers share the /tx/ and /token/ paths.
 */
export function networkName(chainId: number): string {
  return isSolana(chainId) ? SOLANA.name : (getChain(chainId)?.name ?? `Chain ${chainId}`);
}

/** Short form for tags: "Robinhood Chain" → "Robinhood", Solana stays Solana. */
export function networkLabel(chainId: number): string {
  if (isSolana(chainId)) return SOLANA.name;
  const chain = getChain(chainId);
  return chain ? chainLabel(chain) : `Chain ${chainId}`;
}

export function networkShort(chainId: number): string {
  return isSolana(chainId) ? SOLANA.shortName : (getChain(chainId)?.shortName ?? String(chainId));
}

export function nativeSymbol(chainId: number): string {
  return isSolana(chainId)
    ? SOLANA.nativeCurrency.symbol
    : (getChain(chainId)?.nativeCurrency.symbol ?? 'ETH');
}

export function explorerUrl(chainId: number): string {
  return isSolana(chainId)
    ? SOLANA.explorer.url
    : (getChain(chainId)?.explorer.url ?? 'https://etherscan.io');
}

/** A transaction: its EVM hash, or a Solana signature. */
export function txUrl(chainId: number, hashOrSig: string): string {
  return `${explorerUrl(chainId)}/tx/${hashOrSig}`;
}

export function tokenUrl(chainId: number, token: string): string {
  return `${explorerUrl(chainId)}/token/${token}`;
}
