import type { SolAddress } from '../../../shared/solana';
import { isSolAddress } from '../../../shared/solana';
import { STABLE_MINTS, WSOL_MINT } from '../address';
import type { AccountInfo, SolRpc } from '../rpc';
import { launchLab, type LaunchLabVenue } from './launchlab';
import { meteoraDamm, type MeteoraDammVenue } from './meteora-damm';
import { meteoraDbc, type MeteoraDbcVenue } from './meteora-dbc';
import { meteoraDlmm, type MeteoraDlmmVenue } from './meteora-dlmm';
import { orca, type OrcaVenue } from './orca';
import { raydiumAmm, type RaydiumAmmVenue } from './raydium-amm';
import { raydiumCpmm, type RaydiumCpmmVenue } from './raydium-cpmm';
import type { DexKind, DexModule, DexVenueBase } from './types';

export type { DexKind, DexLoadCtx, DexModule } from './types';

/** A pool on one of the programs below, read from chain. */
export type DexVenue =
  | RaydiumAmmVenue
  | RaydiumCpmmVenue
  | LaunchLabVenue
  | MeteoraDammVenue
  | MeteoraDbcVenue
  | MeteoraDlmmVenue
  | OrcaVenue;

const MODULES: { [K in DexKind]: DexModule<Extract<DexVenue, DexVenueBase<K>>> } = {
  'raydium-amm': raydiumAmm,
  'raydium-cpmm': raydiumCpmm,
  launchlab: launchLab,
  'meteora-damm': meteoraDamm,
  'meteora-dbc': meteoraDbc,
  'meteora-dlmm': meteoraDlmm,
  orca,
};

export const DEX_MODULES: readonly DexModule<DexVenue>[] = Object.values(MODULES) as never;

export const dexModule = (v: DexVenue): DexModule<DexVenue> =>
  MODULES[v.dex] as DexModule<DexVenue>;

/** The module whose program owns an account, if any. */
export const moduleOf = (owner: SolAddress): DexModule<DexVenue> | undefined =>
  DEX_MODULES.find((m) => m.program === owner);

/** Mints a pool may price a coin in: wrapped SOL and the dollar stablecoins. */
export const isDexQuote = (mint: SolAddress) => mint === WSOL_MINT || STABLE_MINTS.has(mint);

/**
 * Reads asked for in the same moment go out as one `getMultipleAccounts` call, so the
 * pools of a coin cost one request between them.
 */
export function batchedReader(
  rpc: SolRpc,
): (keys: readonly SolAddress[]) => Promise<(AccountInfo | null)[]> {
  let queue: {
    keys: readonly SolAddress[];
    done: (r: Map<SolAddress, AccountInfo | null>) => void;
    fail: (e: unknown) => void;
  }[] = [];
  const flush = () => {
    const jobs = queue;
    queue = [];
    const keys = [...new Set(jobs.flatMap((j) => j.keys))];
    rpc.getMultipleAccounts(keys).then(
      (accs) => {
        const byKey = new Map(keys.map((k, i) => [k, accs[i] ?? null]));
        for (const j of jobs) j.done(byKey);
      },
      (e: unknown) => {
        for (const j of jobs) j.fail(e);
      },
    );
  };
  return (keys) =>
    new Promise((resolve, reject) => {
      if (keys.length === 0) return resolve([]);
      if (queue.length === 0) setTimeout(flush, 0);
      queue.push({
        keys,
        done: (byKey) => resolve(keys.map((k) => byKey.get(k) ?? null)),
        fail: reject,
      });
    });
}

/** A pool the index lists for a coin, with the liquidity it reports (USD). */
export interface IndexedPool {
  pool: SolAddress;
  liquidityUsd: number;
}

interface IndexPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
}

/**
 * The pools the index (DEX Screener) lists for `mint` against wrapped SOL or a
 * stablecoin (or only the mints `against` allows), most liquid first. Only addresses are
 * taken from it: each pool is read and checked on chain before anything is quoted on it.
 * Throws when the index does not answer with a list (rate limited, down), which is not the
 * same as listing nothing.
 */
export async function indexedPools(
  fetchJson: (url: string) => Promise<unknown>,
  mint: SolAddress,
  max: number,
  against: (other: SolAddress) => boolean = isDexQuote,
): Promise<IndexedPool[]> {
  const json = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`);
  if (!Array.isArray(json)) throw new Error('The pool index did not answer');
  const pairs = json as IndexPair[];
  const out: IndexedPool[] = [];
  for (const p of pairs) {
    const base = p.baseToken?.address;
    const quote = p.quoteToken?.address;
    const other = base === mint ? quote : quote === mint ? base : undefined;
    const pool = p.pairAddress;
    if (p.chainId !== 'solana' || !other || !against(other) || !pool || !isSolAddress(pool))
      continue;
    if (out.some((o) => o.pool === pool)) continue;
    out.push({ pool, liquidityUsd: Number(p.liquidity?.usd) || 0 });
  }
  out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return out.slice(0, max);
}
