import type { Address, Hex, PublicClient } from 'viem';
import { erc20Abi, multicall3Abi } from './chain/abis';
import { MULTICALL3 } from './chain/client';
import type { SolRpc } from './solana/rpc';
import type { EvmReader, SolReader } from './tracker';
import type { SolTxJson } from './tracker-parse';

/** The wallet tracker's Solana reads, over the user's RPC (or the public one). */
export function solReader(rpc: SolRpc): SolReader {
  return {
    async signatures(address, limit, until) {
      const r = await rpc.call<{ signature: string; err: unknown; blockTime?: number | null }[]>(
        'getSignaturesForAddress',
        [address, { limit, commitment: 'confirmed', ...(until ? { until } : {}) }],
      );
      return r.map((s) => ({
        sig: s.signature,
        failed: s.err !== null && s.err !== undefined,
        at: typeof s.blockTime === 'number' ? s.blockTime * 1000 : null,
      }));
    },
    // Up to v1: the node refuses a newer transaction than the reader says it can read.
    transaction: (sig) =>
      rpc.call<SolTxJson | null>('getTransaction', [
        sig,
        { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
      ]),
  };
}

/** An OP chain's receipt also names the L1 fee its sender paid, as hex. */
function l1Fee(receipt: unknown): bigint {
  const v = (receipt as { l1Fee?: unknown }).l1Fee;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v);
  return 0n;
}

/** The wallet tracker's EVM reads on one chain. */
export function evmReader(client: PublicClient): EvmReader {
  return {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async balances(addresses, block) {
      const r = await client.multicall({
        allowFailure: true,
        blockNumber: block,
        contracts: addresses.map(
          (a) =>
            ({
              address: MULTICALL3,
              abi: multicall3Abi,
              functionName: 'getEthBalance',
              args: [a as Address],
            }) as const,
        ),
      });
      return r.map((x) => (x.status === 'success' ? (x.result as bigint) : null));
    },
    nonce: (address, block) =>
      client.getTransactionCount({ address: address as Address, blockNumber: block }),
    async block(n) {
      const b = await client.getBlock({ blockNumber: n, includeTransactions: true });
      return {
        at: Number(b.timestamp) * 1000,
        txs: b.transactions.map((t) => ({
          hash: t.hash,
          from: t.from.toLowerCase(),
          value: t.value,
        })),
      };
    },
    async receipt(hash) {
      const r = await client.getTransactionReceipt({ hash: hash as Hex });
      return {
        ok: r.status === 'success',
        fee: r.gasUsed * r.effectiveGasPrice + l1Fee(r),
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      };
    },
    async decimals(token) {
      const d = await client.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: 'decimals',
      });
      return Number(d);
    },
    symbol: (token) =>
      client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'symbol' }),
  };
}
