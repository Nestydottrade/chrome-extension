import { parseEther } from 'viem';
import { bridgeAsset, chainLabel, getChain } from './chains';
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

/**
 * Native kept back by a bridge's MAX on an EVM chain for gas: one deposit, or three
 * transactions (swap, approval, deposit) where bridges leave in a token (bridgeVia).
 * Solana works its own reserve out.
 */
export function bridgeGasReserve(chainId: number): bigint {
  const one =
    chainId === 1
      ? parseEther('0.002')
      : chainId === 56
        ? parseEther('0.0005')
        : parseEther('0.0002');
  const chain = getChain(chainId);
  return chain && bridgeAsset(chain) ? one * 5n : one;
}

export function tokenUrl(chainId: number, token: string): string {
  return `${explorerUrl(chainId)}/token/${token}`;
}
