import { getChain } from './chains';
import { formatCompact, formatTiny } from './format';
import { isNestySite } from './nesty-site';
import { sanitizeLabel } from './sanitize';
import { isSolana } from './solana';

/**
 * Price alerts: the Nesty website sets them, the extension keeps them, reads the coins'
 * prices while the browser runs and shows a notification once one is reached. Each fires
 * once, then is gone.
 */

/** At most this many alerts, over every coin and site. */
export const MAX_ALERTS = 50;
/** How often the prices are read, in minutes (the shortest an alarm repeats). */
export const ALERT_CHECK_MINUTES = 0.5;

export interface PriceAlert {
  id: string;
  /** The site that set it: a click on its notification opens the coin there. */
  origin: string;
  chainId: number;
  /** A mint, or an EVM address in lower case. */
  token: string;
  /** As the site named it, cleaned: for the notification. */
  symbol: string;
  /** Fires once the price is at or above `price`; else at or below it. */
  above: boolean;
  /** USD. */
  price: number;
  /**
   * When the user gave a market cap: the coins it counts (market cap over price), so the
   * notification says the market cap too.
   */
  supply: number | null;
  at: number;
}

/** An alert as the site sees it: with the latest price read for its coin. */
export type AlertView = Omit<PriceAlert, 'origin'> & {
  /** The latest price read, in USD; null when none has been read, or none was found. */
  now: number | null;
  /** When its coin's price was last asked for; null before the first time. */
  checkedAt: number | null;
};

export interface AlertInput {
  chainId: number;
  token: string;
  symbol: string;
  above: boolean;
  price: number;
  supply?: number | undefined;
}

const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The chain's name in the price feed and in the site's links ('solana', 'base', …); null when it has none. */
export function alertSlug(chainId: number): string | null {
  if (isSolana(chainId)) return 'solana';
  return getChain(chainId)?.dexscreenerSlug ?? null;
}

/** The coin's address as alerts keep it (EVM in lower case, a mint exactly); null when it is not one. */
export function alertToken(chainId: number, token: string): string | null {
  if (isSolana(chainId)) return SOL_ADDRESS.test(token) ? token : null;
  return EVM_ADDRESS.test(token) ? token.toLowerCase() : null;
}

export const alertSymbol = (symbol: string): string => sanitizeLabel(symbol, 16) || 'A coin';

interface FeedPair {
  baseToken?: { address?: unknown };
  priceUsd?: unknown;
  liquidity?: { usd?: unknown };
}

/**
 * Each asked-for coin's USD price, from the price feed's answer: its most liquid pair's,
 * among those it is the base of. A coin the answer leaves out has none.
 */
export function pricesFromFeed(
  chainId: number,
  tokens: readonly string[],
  json: unknown,
): Map<string, number> {
  const pairs: unknown = Array.isArray(json) ? json : (json as { pairs?: unknown } | null)?.pairs;
  const best = new Map<string, { liquidity: number; price: number }>();
  if (!Array.isArray(pairs)) return new Map();
  const wanted = new Set(tokens);
  for (const p of pairs as (FeedPair | null)[]) {
    const raw = p?.baseToken?.address;
    const token = typeof raw === 'string' ? alertToken(chainId, raw) : null;
    if (!token || !wanted.has(token)) continue;
    const price = Number(p?.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const liquidity = Number(p?.liquidity?.usd);
    const l = Number.isFinite(liquidity) ? liquidity : 0;
    const cur = best.get(token);
    if (!cur || l > cur.liquidity) best.set(token, { liquidity: l, price });
  }
  return new Map([...best].map(([t, b]) => [t, b.price]));
}

/** True when the price reached the alert's. */
export const alertDue = (a: Pick<PriceAlert, 'above' | 'price'>, price: number): boolean =>
  a.above ? price >= a.price : price <= a.price;

const money = (usd: number) => (usd < 0.001 ? `$${formatTiny(usd)}` : `$${formatCompact(usd)}`);

/** What the notification of a reached alert says. */
export function alertText(a: PriceAlert, price: number): { title: string; message: string } {
  const verb = a.above ? 'rose to' : 'fell to';
  if (a.supply !== null) {
    return {
      title: `${a.symbol} ${verb} ${money(a.price * a.supply)} market cap`,
      message: `Market cap now ${money(price * a.supply)}. Click to open the coin.`,
    };
  }
  return {
    title: `${a.symbol} ${verb} ${money(a.price)}`,
    message: `Price now ${money(price)}. Click to open the coin.`,
  };
}

const NOTE = 'alert';

/** The notification's id: what a click on it needs to open the coin. */
export const alertNoteId = (a: PriceAlert): string =>
  [NOTE, a.id, String(a.chainId), a.token, a.origin].join('|');

/**
 * The page a click on an alert's notification opens: the coin's, on the Nesty site that
 * set it. Null for any other notification, and for an id that does not hold together.
 */
export function alertPage(noteId: string): string | null {
  const [kind, id, chain, token, origin, ...rest] = noteId.split('|');
  if (kind !== NOTE || !id || !chain || !token || !origin || rest.length > 0) return null;
  const chainId = Number(chain);
  const slug = Number.isSafeInteger(chainId) ? alertSlug(chainId) : null;
  if (!slug || alertToken(chainId, token) !== token || !isNestySite(origin)) return null;
  return `${origin}/#/token/${slug}/${token}`;
}
