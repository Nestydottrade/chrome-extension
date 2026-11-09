import type { Address, PublicClient } from 'viem';
import { erc20Abi, multicall3Abi } from './chain/abis';
import { MULTICALL3 } from './chain/client';

export interface WalletBalance {
  address: Address;
  native: bigint;
  token: bigint;
}

/**
 * Each wallet's balance of `token` in one multicall, or null where its read failed: never
 * taken for zero, since a sell sized on it would sell nothing.
 */
export async function readTokenBalances(
  client: PublicClient,
  token: Address,
  wallets: readonly Address[],
): Promise<(bigint | null)[]> {
  if (wallets.length === 0) return [];
  const results = await client.multicall({
    allowFailure: true,
    contracts: wallets.map(
      (w) => ({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w] }) as const,
    ),
  });
  return results.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
}

/** Native + token balance for many wallets in one multicall. */
export async function readBalances(
  client: PublicClient,
  token: Address | null,
  wallets: readonly Address[],
): Promise<WalletBalance[]> {
  if (wallets.length === 0) return [];
  const results = await client.multicall({
    allowFailure: true,
    contracts: wallets.flatMap((w) => [
      {
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: 'getEthBalance',
        args: [w],
      } as const,
      ...(token
        ? [{ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w] } as const]
        : []),
    ]),
  });
  const step = token ? 2 : 1;
  return wallets.map((address, i) => {
    const n = results[i * step];
    const t = token ? results[i * step + 1] : undefined;
    return {
      address,
      native: n?.status === 'success' ? (n.result as bigint) : 0n,
      token: t?.status === 'success' ? (t.result as bigint) : 0n,
    };
  });
}
