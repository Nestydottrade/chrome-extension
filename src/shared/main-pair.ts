/**
 * Which of a token's listed pairs is its main one: for the site's pages and the extension's
 * Tracker and alerts alike, or one would tell a market cap the other does not.
 */

/** What picking a main pair reads of a listed pair. */
export interface ListedPair {
  dexId?: string;
  baseToken: { address: string };
  liquidity?: { usd?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
}

/**
 * Launchpad curves, as DEX Screener names them. It keeps listing a curve after its coin has
 * moved to a pool, with the trades of its last hours.
 */
export const CURVES: ReadonlySet<string> = new Set(['pumpfun', 'bags', 'meteoradbc', 'flapsh']);

const WINDOWS = ['h1', 'h6', 'h24'] as const;

/** A pair's trades in the last hour, 6 hours and day. */
const trades = (p: ListedPair) =>
  WINDOWS.map((w) => (p.txns?.[w]?.buys ?? 0) + (p.txns?.[w]?.sells ?? 0));

/** Whether pair a trades more than pair b: in the last hour, else 6 hours, else the day. */
function busier(a: ListedPair, b: ListedPair): boolean {
  const ta = trades(a);
  const tb = trades(b);
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return (ta[i] ?? 0) > (tb[i] ?? 0);
  return false;
}

/**
 * The pair most of a token's trading happens in: its deepest by USD liquidity. A pair DEX
 * Screener gives no liquidity (one quoted in a coin it cannot price, like RAM on AMD) is not
 * empty, only unpriced: it takes over when it trades more than the deepest pair and the curve.
 * A curve without a figure never does, as its last trades still count once its coin has left.
 */
export function mainPair<P extends ListedPair>(pairs: readonly P[], token: string): P | null {
  let deepest: P | null = null;
  let busiest: P | null = null;
  let curve: P | null = null;
  for (const p of pairs) {
    if (p.baseToken.address.toLowerCase() !== token.toLowerCase()) continue;
    const usd = p.liquidity?.usd;
    if (usd !== undefined) {
      if (!deepest || usd > (deepest.liquidity?.usd ?? 0)) deepest = p;
    } else if (CURVES.has(p.dexId ?? '')) {
      if (!curve || busier(p, curve)) curve = p;
    } else if (!busiest || busier(p, busiest)) busiest = p;
  }
  if (busiest && (!deepest || busier(busiest, deepest)) && (!curve || busier(busiest, curve)))
    return busiest;
  return deepest ?? curve ?? busiest;
}

/** A pair as a feed sent it: untrusted, so any field may hold anything. */
export interface FeedPair {
  dexId?: unknown;
  baseToken?: { address?: unknown; symbol?: unknown };
  priceUsd?: unknown;
  marketCap?: unknown;
  fdv?: unknown;
  liquidity?: { usd?: unknown };
  txns?: unknown;
}

/** A coin's main pair in a feed's answer, with the price it has there. */
export interface PricedPair extends ListedPair {
  feed: FeedPair;
  priceUsd: number;
}

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function txnsOf(raw: unknown): NonNullable<ListedPair['txns']> {
  if (typeof raw !== 'object' || raw === null) return {};
  const windows = raw as Record<string, { buys?: unknown; sells?: unknown } | null | undefined>;
  return Object.fromEntries(
    WINDOWS.map((w) => [
      w,
      { buys: finite(windows[w]?.buys) ?? 0, sells: finite(windows[w]?.sells) ?? 0 },
    ]),
  );
}

/**
 * Each asked-for coin's main pair in a feed's answer, among those it is the base of that have a
 * price: without one a pair says nothing of what the coin is worth, however busy it is.
 * `own` turns a listed address into the form `tokens` holds it in; null where it is no coin.
 */
export function feedPairs(
  json: unknown,
  tokens: readonly string[],
  own: (address: string) => string | null,
): Map<string, PricedPair> {
  const found = new Map<string, PricedPair>();
  const pairs: unknown = Array.isArray(json) ? json : (json as { pairs?: unknown } | null)?.pairs;
  if (!Array.isArray(pairs)) return found;
  const wanted = new Set(tokens);
  const groups = new Map<string, PricedPair[]>();
  for (const p of pairs as (FeedPair | null)[]) {
    const raw = p?.baseToken?.address;
    const token = typeof raw === 'string' ? own(raw) : null;
    if (!p || !token || !wanted.has(token)) continue;
    const priceUsd = Number(p.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const usd = finite(p.liquidity?.usd);
    const pair: PricedPair = {
      ...(typeof p.dexId === 'string' ? { dexId: p.dexId } : {}),
      baseToken: { address: token },
      ...(usd === undefined ? {} : { liquidity: { usd } }),
      txns: txnsOf(p.txns),
      feed: p,
      priceUsd,
    };
    const group = groups.get(token);
    if (group) group.push(pair);
    else groups.set(token, [pair]);
  }
  for (const [token, group] of groups) {
    const main = mainPair(group, token);
    if (main) found.set(token, main);
  }
  return found;
}
