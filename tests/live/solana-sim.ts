import { base58 } from '@scure/base';
import { associatedTokenAddress } from '../../src/background/solana/address';
import { decodeTokenAccount } from '../../src/background/solana/layouts';
import { SolRpc } from '../../src/background/solana/rpc';
import { setComputeUnitLimit, setComputeUnitPrice } from '../../src/background/solana/spl';
import {
  compileMessage,
  serializeTransaction,
  type Instruction,
} from '../../src/background/solana/tx';
import { fromBase64, toBase64 } from '../../src/shared/base64';
import { SOLANA } from '../../src/shared/solana';

/**
 * Mainnet reads and simulations for the live Solana tests: no keys, nothing sent.
 * Finding traders reads a lot of history: api.mainnet-beta answers that here (no Origin),
 * though it refuses the extension.
 */
export const rpc = new SolRpc(['https://api.mainnet-beta.solana.com', ...SOLANA.rpcUrls]);

interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

interface RawTx {
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { instructions: RawIx[] }[] | null;
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
}

export interface SeenIx {
  program: string;
  data: Uint8Array;
  accounts: string[];
}

/** The successful transactions that touched `address`, newest first: signer and instructions. */
export async function* trades(address: string, max: number) {
  let before: string | undefined;
  let seen = 0;
  while (seen < max) {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [
      address,
      { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) },
    ]);
    if (sigs.length === 0) return;
    before = sigs[sigs.length - 1]?.signature;
    for (const s of sigs) {
      if (s.err) continue;
      if (seen++ >= max) return;
      const tx = await rpc
        .call<RawTx | null>('getTransaction', [
          s.signature,
          { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
        ])
        .catch(() => null);
      if (!tx?.meta || tx.meta.err) continue;
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const all = [
        ...tx.transaction.message.instructions,
        ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
      ];
      yield {
        signer: keys[0] ?? '',
        ixs: all.map((ix): SeenIx => ({
          program: keys[ix.programIdIndex] ?? '',
          data: base58.decode(ix.data),
          accounts: ix.accounts.map((a) => keys[a] ?? ''),
        })),
      };
    }
  }
}

export const budget = (ixs: Instruction[], units = 1_400_000) => [
  setComputeUnitLimit(units),
  setComputeUnitPrice(1_000n),
  ...ixs,
];

/** What `owner` holds of a token in its associated account (0 without one). */
export async function held(owner: string, mint: string, program: string): Promise<bigint> {
  const acc = await rpc.getAccount(associatedTokenAddress(owner, mint, program));
  return (acc && decodeTokenAccount(acc.data)?.amount) ?? 0n;
}

/**
 * Simulates `ixs` paid by `owner`, and returns the token amounts of `watch` after it (0
 * for an account that does not exist then).
 */
export async function simulate(owner: string, ixs: Instruction[], watch: string[] = []) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const raw = serializeTransaction(compileMessage(owner, ixs, blockhash), []);
  const r = await rpc.call<{
    value: {
      err: unknown;
      logs: string[] | null;
      unitsConsumed?: number;
      accounts?: ({ data: [string, string] } | null)[] | null;
    };
  }>('simulateTransaction', [
    toBase64(raw),
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      ...(watch.length > 0 ? { accounts: { encoding: 'base64', addresses: watch } } : {}),
    },
  ]);
  return {
    err: r.value.err,
    logs: (r.value.logs ?? []).join('\n'),
    units: r.value.unitsConsumed ?? 0,
    bytes: raw.length,
    after: (r.value.accounts ?? []).map((a) =>
      a ? (decodeTokenAccount(fromBase64(a.data[0]))?.amount ?? 0n) : 0n,
    ),
    /** The watched accounts as the simulation left them. */
    raw: (r.value.accounts ?? []).map((a) => (a ? fromBase64(a.data[0]) : null)),
  };
}
