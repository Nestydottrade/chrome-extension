import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type ContractFunctionParameters,
  type PublicClient,
} from 'viem';
import type { ChainConfig } from '../../shared/chains';

/** Deployed at the same address on all supported chains (checked via eth_getCode). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

/**
 * Calldata per Multicall3 request, in bytes. viem's default 1 KB split a pool's handful of
 * quotes into two or three requests. 8 KB holds about 25 v4 or 50 v3 quotes, far below an
 * eth_call's gas cap.
 */
const MULTICALL_BYTES = 8_192;

export function toViemChain(c: ChainConfig) {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: c.rpcUrls } },
    blockExplorers: { default: { name: c.explorer.name, url: c.explorer.url } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/** One cached client per chain + RPC list. Custom RPCs (settings) go first. */
export class ClientPool {
  private readonly clients = new Map<string, PublicClient>();

  get(chain: ChainConfig, customRpcs: readonly string[] = []): PublicClient {
    const urls = [...new Set([...customRpcs, ...chain.rpcUrls])];
    const key = `${chain.id}|${urls.join(',')}`;
    let client = this.clients.get(key);
    if (!client) {
      client = createPublicClient({
        chain: toViemChain(chain),
        transport: fallback(urls.map((u) => http(u, { timeout: 8_000, retryCount: 1 }))),
        batch: { multicall: { wait: 0, batchSize: MULTICALL_BYTES } },
      });
      this.clients.set(key, client);
    }
    return client;
  }
}

/** One call's outcome, as a multicall that allows failures reports it. */
export type SharedResult =
  { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

interface Waiting {
  contracts: readonly ContractFunctionParameters[];
  resolve: (results: SharedResult[]) => void;
  reject: (error: unknown) => void;
}

/** Calls waiting to go out together, per client. */
const sharing = new WeakMap<PublicClient, Waiting[]>();

/**
 * A multicall that allows failures and goes out together with the other shared calls made
 * on the same client in the same tick. A quote round over twenty pools then costs one
 * request, or one per 8 KB, instead of one per pool.
 *
 * Only for calls that run known code. Multicall3 hands each call all but 1/64 of the gas
 * left, so one call that burns its gas starves the calls after it in the same request.
 */
export function sharedMulticall(
  client: PublicClient,
  contracts: readonly ContractFunctionParameters[],
): Promise<SharedResult[]> {
  if (contracts.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    let waiting = sharing.get(client);
    if (!waiting) {
      const batch: Waiting[] = [];
      waiting = batch;
      sharing.set(client, batch);
      setTimeout(() => {
        sharing.delete(client);
        void send(client, batch);
      }, 0);
    }
    waiting.push({ contracts, resolve, reject });
  });
}

async function send(client: PublicClient, batch: readonly Waiting[]): Promise<void> {
  try {
    const results: SharedResult[] = await client.multicall({
      allowFailure: true,
      contracts: batch.flatMap((w) => w.contracts),
    });
    let at = 0;
    for (const w of batch) {
      w.resolve(results.slice(at, at + w.contracts.length));
      at += w.contracts.length;
    }
  } catch (e) {
    for (const w of batch) w.reject(e);
  }
}
