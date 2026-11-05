import { alertSlug, alertToken } from './alerts';
import { formatCompact } from './format';
import { isNestySite } from './nesty-site';
import { nativeSymbol, networkLabel } from './networks';
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

interface FeedPair {
  baseToken?: { address?: unknown; symbol?: unknown };
  priceUsd?: unknown;
  marketCap?: unknown;
  fdv?: unknown;
  liquidity?: { usd?: unknown };
}

export interface FeedCoin {
  symbol: string | null;
  priceUsd: number;
  /** Market cap, else fully diluted value; null when the feed has neither. */
  mcap: number | null;
}

/**
 * Each asked-for coin's symbol, USD price and market cap, from the price feed's answer:
 * its most liquid pair's, among those it is the base of.
 */
export function coinsFromFeed(
  chainId: number,
  tokens: readonly string[],
  json: unknown,
): Map<string, FeedCoin> {
  const pairs: unknown = Array.isArray(json) ? json : (json as { pairs?: unknown } | null)?.pairs;
  const best = new Map<string, FeedCoin>();
  const depth = new Map<string, number>();
  if (!Array.isArray(pairs)) return best;
  const wanted = new Set(tokens);
  for (const p of pairs as (FeedPair | null)[]) {
    const raw = p?.baseToken?.address;
    const token = typeof raw === 'string' ? alertToken(chainId, raw) : null;
    if (!token || !wanted.has(token)) continue;
    const priceUsd = Number(p?.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const l = Number(p?.liquidity?.usd);
    const liquidity = Number.isFinite(l) ? l : 0;
    const cur = depth.get(token);
    if (cur !== undefined && liquidity <= cur) continue;
    const cap = [p?.marketCap, p?.fdv].map(Number).find((v) => Number.isFinite(v) && v > 0);
    depth.set(token, liquidity);
    best.set(token, {
      symbol: sanitizeLabel(p?.baseToken?.symbol, 16) || null,
      priceUsd,
      mcap: cap ?? null,
    });
  }
  return best;
}

/** What a trade's notification says: "Curve sniper bought AAPLCAT", "2.40 SOL ($412) at $84.2K MC on Solana". */
export function tradeText(
  who: Pick<FollowedWallet, 'name' | 'address'>,
  t: TrackedTrade,
): { title: string; message: string } {
  const coin = t.symbol ?? shortAddress(t.token);
  const title = `${who.name || shortAddress(who.address)} ${t.side === 'buy' ? 'bought' : 'sold'} ${coin}`;
  const usd = t.usd !== null ? `$${formatCompact(t.usd)}` : null;
  const amount =
    t.native !== null
      ? `${coinAmount(t.native)} ${nativeSymbol(t.chainId)}${usd ? ` (${usd})` : ''}`
      : (usd ?? `${formatCompact(t.tokens)} ${coin}`);
  const cap = t.mcap !== null ? ` at $${formatCompact(t.mcap)} MC` : '';
  return { title, message: `${amount}${cap} on ${networkLabel(t.chainId)}` };
}

const NOTE = 'track';

/** A trade's notification id: what its click and its buttons need. */
export const trackNoteId = (w: Pick<FollowedWallet, 'id' | 'origin'>, t: TrackedTrade): string =>
  [NOTE, w.id, String(t.chainId), t.token, t.hash.slice(0, 24), w.origin].join('|');

/**
 * What a tracker notification points at: its coin's page on the Nesty site that follows
 * the wallet, and the wallet (for Mute). Null for any other notification.
 */
export function trackNote(
  noteId: string,
): { page: string; walletId: string; origin: string } | null {
  const [kind, walletId, chain, token, hash, origin, ...rest] = noteId.split('|');
  if (kind !== NOTE || !walletId || !chain || !token || !hash || !origin || rest.length > 0)
    return null;
  const chainId = Number(chain);
  const slug = Number.isSafeInteger(chainId) ? alertSlug(chainId) : null;
  if (!slug || alertToken(chainId, token) !== token || !isNestySite(origin)) return null;
  return { page: `${origin}/#/token/${slug}/${token}`, walletId, origin };
}
