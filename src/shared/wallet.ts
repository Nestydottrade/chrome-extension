import type { Address } from 'viem';

/** Public view of a wallet account. Contains no secret material. */
export interface WalletAccount {
  id: string;
  name: string;
  /** EVM address. A wallet imported from a Solana key has none. */
  address?: Address;
  hidden: boolean;
  primary: boolean;
  kind: 'derived' | 'imported';
  /** BIP-44 address index for derived accounts. */
  index?: number;
  /**
   * Solana address: m/44'/501'/index'/0' for derived accounts, the key's own for one
   * imported from a Solana key. A wallet imported from an EVM key has none.
   */
  solana?: string;
}

/** A wallet that can use EVM chains: every wallet but one imported from a Solana key. */
export type EvmAccount = WalletAccount & { address: Address };

export function hasEvm(a: WalletAccount): a is EvmAccount {
  return a.address !== undefined;
}

/**
 * The wallet used when none is picked: the default one where it has an address on the
 * network, otherwise the first visible one that does.
 */
export function fallbackWallet<T extends WalletAccount>(usable: readonly T[]): T | undefined {
  return usable.find((a) => a.primary) ?? usable.find((a) => !a.hidden) ?? usable[0];
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
