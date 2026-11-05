import type { ChainConfig } from '../shared/chains';
import { STABLE_MINTS, WSOL_MINT } from './solana/address';

/**
 * Reads a followed wallet's trade out of one transaction: exactly one coin in or out, paid
 * for in the chain's coin (wrapped or not) or a dollar stablecoin. Anything else (a
 * transfer, a claim, liquidity) is not a trade.
 */

export interface ParsedTrade {
  side: 'buy' | 'sell';
  token: string;
  /** Coins in or out, raw. */
  raw: bigint;
  /** Their decimals; null when the transaction does not say (EVM). */
  decimals: number | null;
  /** The chain's coin paid or received, in its smallest unit; null when paid in a stablecoin. */
  native: bigint | null;
  /** Dollars paid or received in a stablecoin; null when paid in the chain's coin. */
  stableUsd: number | null;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

// ── Solana ──────────────────────────────────────────────────────────────────

interface SolTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** getTransaction's answer, encoding 'json': only what is read here. */
export interface SolTxJson {
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: SolTokenBalance[];
    postTokenBalances?: SolTokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

/** The trade `owner` made in a Solana transaction; null when it is not one. */
export function solTrade(tx: SolTxJson, owner: string): ParsedTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const at = keys.indexOf(owner);
  if (at < 0) return null;
  const own = (b: SolTokenBalance) => b.owner === owner;
  const pre = (meta.preTokenBalances ?? []).filter(own);
  const post = (meta.postTokenBalances ?? []).filter(own);
  const moved = new Map<string, { raw: bigint; decimals: number }>();
  const count = (b: SolTokenBalance, sign: bigint) => {
    if (b.mint === WSOL_MINT) return;
    const m = moved.get(b.mint) ?? { raw: 0n, decimals: b.uiTokenAmount.decimals };
    m.raw += sign * BigInt(b.uiTokenAmount.amount);
    moved.set(b.mint, m);
  };
  for (const b of post) count(b, 1n);
  for (const b of pre) count(b, -1n);
  const changed = [...moved].filter(([, m]) => m.raw !== 0n);
  const coins = changed.filter(([mint]) => !STABLE_MINTS.has(mint));
  const stables = changed.filter(([mint]) => STABLE_MINTS.has(mint));
  const coin = coins.length === 1 ? coins[0] : undefined;
  if (!coin || stables.length > 1) return null;
  const [token, m] = coin;
  const side = m.raw > 0n ? 'buy' : 'sell';
  const trade = { side, token, raw: abs(m.raw), decimals: m.decimals } as const;
  const stable = stables[0];
  if (stable) {
    const [, s] = stable;
    if (side === 'buy' ? s.raw >= 0n : s.raw <= 0n) return null;
    return { ...trade, native: null, stableUsd: Number(abs(s.raw)) / 10 ** s.decimals };
  }
  // Its SOL: its own account and every token account it holds here (wrapped SOL, and the
  // rent of accounts it opened or closed, which stays its own), the network fee given back.
  let lamports = 0n;
  const mine = new Set([at, ...pre.map((b) => b.accountIndex), ...post.map((b) => b.accountIndex)]);
  for (const i of mine)
    lamports += BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
  if (at === 0) lamports += BigInt(meta.fee);
  if (side === 'buy' ? lamports >= 0n : lamports <= 0n) return null;
  return { ...trade, native: abs(lamports), stableUsd: null };
}

// ── EVM ─────────────────────────────────────────────────────────────────────

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Less of the chain's coin than this (0.000001) is a fee's rounding, not a payment. */
const DUST_WEI = 1_000_000_000_000n;

export interface EvmLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/** What a transaction's ERC-20 transfers moved for `wallet`, raw per token (lower case). */
export function evmMoves(logs: readonly EvmLog[], wallet: string): Map<string, bigint> {
  const me = `0x${wallet.slice(2).toLowerCase().padStart(64, '0')}`;
  const out = new Map<string, bigint>();
  for (const l of logs) {
    // Three topics: an ERC-20 transfer (an NFT's has four).
    if (l.topics.length !== 3 || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = l.topics[1]?.toLowerCase();
    const to = l.topics[2]?.toLowerCase();
    if ((from === me) === (to === me)) continue;
    let amount: bigint;
    try {
      amount = BigInt(l.data);
    } catch {
      continue;
    }
    const token = l.address.toLowerCase();
    out.set(token, (out.get(token) ?? 0n) + (to === me ? amount : -amount));
  }
  return out;
}

/**
 * The trade a wallet made in one EVM transaction, from its token moves and the change in
 * its native balance, fees given back (null when that could not be read). Wrapped native
 * counts as native, the chain's stablecoins as dollars.
 */
export function evmTrade(
  chain: Pick<ChainConfig, 'wrappedNative' | 'stablecoins'>,
  moves: ReadonlyMap<string, bigint>,
  nativeDelta: bigint | null,
): ParsedTrade | null {
  const wrapped = chain.wrappedNative.toLowerCase();
  const stables = new Map(chain.stablecoins.map((s) => [s.address.toLowerCase(), s.decimals]));
  let native = nativeDelta;
  let usd = 0;
  const coins: [string, bigint][] = [];
  for (const [token, raw] of moves) {
    if (raw === 0n) continue;
    if (token === wrapped) {
      native = (native ?? 0n) + raw;
      continue;
    }
    const d = stables.get(token);
    if (d !== undefined) usd += Number(raw) / 10 ** d;
    else coins.push([token, raw]);
  }
  const coin = coins.length === 1 ? coins[0] : undefined;
  if (!coin) return null;
  const [token, raw] = coin;
  const side = raw > 0n ? 'buy' : 'sell';
  const trade = { side, token, raw: abs(raw), decimals: null } as const;
  if (side === 'buy' ? usd < 0 : usd > 0)
    return { ...trade, native: null, stableUsd: Math.abs(usd) };
  if (native !== null && abs(native) >= DUST_WEI && (side === 'buy' ? native < 0n : native > 0n))
    return { ...trade, native: abs(native), stableUsd: null };
  return null;
}
