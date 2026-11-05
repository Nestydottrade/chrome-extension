import { formatCompact } from './format';
import { sanitizeLabel } from './sanitize';

/**
 * Wallet tracker: the Nesty website follows wallets, the extension keeps the list, reads
 * their trades while the browser runs and shows a notification for each new one. Solana
 * wallets are read from their latest transactions; an EVM wallet from each transaction it
 * sends once it is followed (public RPCs cannot list a wallet's history).
 */

/** At most this many followed wallets, over every site. */
export const MAX_FOLLOWED = 20;
/** How often the wallets are read, in minutes (the shortest an alarm repeats). */
export const TRACK_CHECK_MINUTES = 0.5;
/** Trades kept: over every wallet, per wallet, and for how long. */
export const TRADES_KEPT = 300;
export const TRADES_PER_WALLET = 60;
export const TRADE_TTL_MS = 7 * 24 * 60 * 60_000;

export type WalletKind = 'solana' | 'evm';

export interface FollowedWallet {
  id: string;
  /** The site that follows it: its notifications open coins there. */
  origin: string;
  kind: WalletKind;
  /** A Solana address exactly, an EVM one in lower case. */
  address: string;
  /** The user's name for it, cleaned; '' when it has none. */
  name: string;
  /** Its new trades show a notification. */
  alerts: boolean;
  at: number;
}

export type FollowedView = Omit<FollowedWallet, 'origin'>;

export interface TrackedTrade {
  /** `${chainId}:${hash}`: one trade per transaction. */
  id: string;
  /** The followed wallet's address, as FollowedWallet keeps it. */
  wallet: string;
  chainId: number;
  /** The transaction: a Solana signature or an EVM hash. */
  hash: string;
  at: number;
  side: 'buy' | 'sell';
  /** A mint, or an EVM address in lower case. */
  token: string;
  /** Coins bought or sold. */
  tokens: number;
  /** The chain's coin paid or received (SOL, ETH, BNB); null when paid in a stablecoin, or unknown. */
  native: number | null;
  /** What it was worth in USD at the time; null when no price was found. */
  usd: number | null;
  /** The coin's symbol, cleaned; null until a price feed names it. */
  symbol: string | null;
  /** The coin's market cap at the trade's price; null when unknown. */
  mcap: number | null;
}

export interface TrackerView {
  /** The wallets this site follows, oldest first. */
  wallets: FollowedView[];
  /** Their trades, newest first. */
  trades: TrackedTrade[];
  /** Trades worth less are not notified. */
  minUsd: number;
  /** The browser does not show the extension's notifications. */
  blocked: boolean;
  /** When the wallets were last read; null before the first time. */
  checkedAt: number | null;
}

export interface FollowInput {
  address: string;
  name?: string | undefined;
}

export interface FollowEdit {
  id: string;
  name?: string | undefined;
  alerts?: boolean | undefined;
}

const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The wallet an address names, as the tracker keeps it; null when it is not one. */
export function walletOf(address: string): { kind: WalletKind; address: string } | null {
  const a = address.trim();
  if (EVM_ADDRESS.test(a)) return { kind: 'evm', address: a.toLowerCase() };
  if (SOL_ADDRESS.test(a)) return { kind: 'solana', address: a };
  return null;
}

export const walletName = (name: unknown): string => sanitizeLabel(name, 24);

/** "7xKX…9fGh": an address in short. */
export const shortAddress = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;

/** An amount of a chain's coin: "2.40", "0.035", "1,250". */
export function coinAmount(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (n >= 1_000) return formatCompact(n);
  if (n >= 1) return n.toFixed(2);
  if (n === 0) return '0';
  return n.toPrecision(2);
}
