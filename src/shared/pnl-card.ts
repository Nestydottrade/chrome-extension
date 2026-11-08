import { formatUnits } from 'viem';
import { getChain } from './chains';
import { formatCompact, formatPercent } from './format';
import { nativeSymbol } from './networks';
import type { TradeTicket } from './panel';
import { ticketFills, type RealizedSell } from './pnl';
import { isSolana } from './solana';

/**
 * A PnL card: one position, still open or closed by a sell, drawn as a picture to share.
 * Its figures are the ones the page shows beside the button that opens it; the activity
 * log adds when the position was opened and the prices it traded at.
 */
export interface PnlCard {
  chainId: number;
  /** The coin: its mint on Solana, else its contract. */
  token: string;
  symbol: string;
  /** The coin's decimals, for reading its supply. */
  decimals: number;
  /** 'open': still held and valued now. 'sold': what one sell fetched. */
  kind: 'open' | 'sold';
  /**
   * What it was bought with (the chain's coin, or on Solana a token such as USDC), and that
   * currency's dollar price now (open) or at the sell.
   */
  unit: { symbol: string; usd: number | null };
  /** In `unit`: what the tokens cost, and what they fetched or are worth now. */
  cost: number;
  value: number;
  /** When the buy that opened the position was sent (ms), if the log has it. */
  start: number | null;
  /** When the sell was sent, or now. */
  end: number;
  /**
   * What the position's trades paid or fetched per whole token, in `unit`, oldest first;
   * the last is the sell's, or today's price.
   */
  points: number[];
  /** Whole tokens in supply, for the market cap; null until known. */
  supply: number | null;
}

/** Where the extension keeps the card its share window shows (storage.session). */
export const SHARE_KEY = 'nesty.share';

const MINUS = '−';

/** Profit in the card's currency, in dollars when it has a price, and in bps of the cost. */
export function cardPnl(c: PnlCard): { units: number; usd: number | null; bps: number } {
  const units = c.value - c.cost;
  return {
    units,
    usd: c.unit.usd === null ? null : units * c.unit.usd,
    bps: Math.round((units / c.cost) * 10_000),
  };
}

/**
 * The market cap when the position was bought and at its end, in dollars: today's (or the
 * sell's) price times the supply, and the entry by the same ratio as the profit. Null
 * without a supply or a dollar price.
 */
export function cardMcap(c: PnlCard): { from: number; to: number } | null {
  const last = c.points[c.points.length - 1];
  if (c.supply === null || c.unit.usd === null || last === undefined || !(c.value > 0)) return null;
  const to = last * c.unit.usd * c.supply;
  return { from: (to * c.cost) / c.value, to };
}

/** "+184.8%", "−42.5%". */
export const signedPercent = (bps: number) =>
  `${bps < 0 ? MINUS : '+'}${formatPercent(Math.abs(bps))}`;

/** "2.31 SOL", or with `sign` "+2.31 SOL"; in dollars "$418.11" and "+$418.11". */
export function amountText(v: number, unit: string | null, sign = false): string {
  const body =
    unit === null ? `$${formatCompact(Math.abs(v))}` : `${formatCompact(Math.abs(v))} ${unit}`;
  return sign ? `${v < 0 ? MINUS : '+'}${body}` : `${v < 0 ? MINUS : ''}${body}`;
}

/** How long a position was held: "45s", "12m", "2h 14m", "5h 02m", "3d 4h". */
export function heldFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const sameCoin = (t: TradeTicket, chainId: number, token: string) =>
  t.chainId === chainId &&
  // Solana mints are base58: compared exactly, never case-folded.
  (isSolana(chainId) ? t.mint === token : t.token?.toLowerCase() === token.toLowerCase());

/**
 * One position of the given wallets in a coin, from the activity log (newest first, as
 * stored): it opens with the first buy after what they bought of it was all sold, and runs
 * to `endId` (a sell) or the latest trade. Tokens are counted as `costBasis` counts them,
 * in one currency (`unit`: null for the chain's coin, else that token's mint). Each trade's
 * price is what those wallets' confirmed swaps in it paid or fetched per whole token.
 */
export function positionTrail(
  history: readonly TradeTicket[],
  p: {
    chainId: number;
    token: string;
    unit: string | null;
    walletIds: readonly string[];
    decimals: number;
    unitDecimals: number;
    endId?: string;
  },
): { start: number | null; points: number[] } {
  const held = new Map<string, bigint>();
  const open = () => [...held.values()].some((v) => v > 0n);
  let start: number | null = null;
  let points: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i] as TradeTicket;
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    if (!sameCoin(t, p.chainId, p.token) || (t.pay?.mint ?? null) !== p.unit) continue;
    const wasOpen = open();
    let paid = 0n;
    let tokens = 0n;
    for (const f of ticketFills(t)) {
      if (!p.walletIds.includes(f.walletId)) continue;
      const pos = held.get(f.walletId) ?? 0n;
      if (t.kind === 'buy') {
        held.set(f.walletId, pos + f.tokens);
        paid += f.paid;
        tokens += f.tokens;
      } else {
        if (pos === 0n) continue;
        held.set(f.walletId, f.tokens < pos ? pos - f.tokens : 0n);
        if (f.fetched === null) continue;
        paid += f.fetched;
        tokens += f.tokens;
      }
    }
    if (t.kind === 'buy' && !wasOpen && open()) {
      start = t.createdAt;
      points = [];
    }
    if (paid > 0n && tokens > 0n)
      points.push(
        Number(formatUnits(paid, p.unitDecimals)) / Number(formatUnits(tokens, p.decimals)),
      );
    if (t.id === p.endId) break;
  }
  return { start, points };
}

/**
 * The card of what the given wallets hold, valued as `unrealisedPnl` values it: only the
 * tokens bought through Nesty and still held, at `tokenUsd`. Null without such tokens or a
 * price.
 */
export function openCard(p: {
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  /** What the coin is bought with: `mint` null for the chain's own coin. */
  unit: { symbol: string; decimals: number; mint: string | null; usd: number | null };
  wallets: readonly {
    id: string;
    token: string;
    cost?: { tokens: string; costWei: string } | undefined;
  }[];
  tokenUsd: number | null;
  supply?: number | null;
  history: readonly TradeTicket[];
  now: number;
}): PnlCard | null {
  if (!p.tokenUsd || !p.unit.usd) return null;
  let covered = 0n;
  let cost = 0n;
  const ids: string[] = [];
  for (const w of p.wallets) {
    const tokens = BigInt(w.cost?.tokens ?? '0');
    const held = BigInt(w.token);
    if (tokens <= 0n || held <= 0n) continue;
    // Sold or sent elsewhere: only what is still held counts, at its average cost.
    const part = held < tokens ? held : tokens;
    covered += part;
    cost += (BigInt(w.cost?.costWei ?? '0') * part) / tokens;
    ids.push(w.id);
  }
  if (covered === 0n || cost <= 0n) return null;
  const price = p.tokenUsd / p.unit.usd;
  const trail = positionTrail(p.history, {
    chainId: p.chainId,
    token: p.token,
    unit: p.unit.mint,
    walletIds: ids,
    decimals: p.decimals,
    unitDecimals: p.unit.decimals,
  });
  return {
    chainId: p.chainId,
    token: p.token,
    symbol: p.symbol,
    decimals: p.decimals,
    kind: 'open',
    unit: { symbol: p.unit.symbol, usd: p.unit.usd },
    cost: Number(formatUnits(cost, p.unit.decimals)),
    value: Number(formatUnits(covered, p.decimals)) * price,
    start: trail.start,
    end: p.now,
    points: [...trail.points, price],
    supply: p.supply ?? null,
  };
}

/** The card of one sell, as `realizedSells` counted it; null without its ticket or a cost. */
export function soldCard(
  sell: RealizedSell,
  history: readonly TradeTicket[],
  supply: number | null = null,
): PnlCard | null {
  const t = history.find((h) => h.id === sell.id);
  if (!t) return null;
  const sol = isSolana(t.chainId);
  const unitDecimals =
    t.pay?.decimals ?? (sol ? 9 : (getChain(t.chainId)?.nativeCurrency.decimals ?? 18));
  const decimals = t.decimals ?? (sol ? 6 : 18);
  const cost = Number(formatUnits(sell.cost, unitDecimals));
  if (!(cost > 0)) return null;
  const walletIds = [
    ...new Set(
      t.legs.filter((l) => l.kind === 'swap' && l.status === 'confirmed').map((l) => l.walletId),
    ),
  ];
  const trail = positionTrail(history, {
    chainId: t.chainId,
    token: sell.token,
    unit: sell.unit,
    walletIds,
    decimals,
    unitDecimals,
    endId: t.id,
  });
  if (trail.points.length === 0) return null;
  return {
    chainId: t.chainId,
    token: sol ? sell.token : (t.token ?? sell.token),
    symbol: t.symbol ?? sell.token.slice(0, 6),
    decimals,
    kind: 'sold',
    unit: { symbol: t.pay?.symbol ?? nativeSymbol(t.chainId), usd: t.nativeUsd ?? null },
    cost,
    value: Number(formatUnits(sell.proceeds, unitDecimals)),
    start: trail.start,
    end: sell.at,
    points: trail.points,
    supply,
  };
}

/** A card as storage hands it back: checked field by field before it is drawn. */
export function readCard(v: unknown): PnlCard | null {
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const unit = c.unit as Record<string, unknown> | null | undefined;
  const ok =
    num(c.chainId) &&
    typeof c.token === 'string' &&
    typeof c.symbol === 'string' &&
    num(c.decimals) &&
    (c.kind === 'open' || c.kind === 'sold') &&
    typeof unit === 'object' &&
    unit !== null &&
    typeof unit.symbol === 'string' &&
    (unit.usd === null || num(unit.usd)) &&
    num(c.cost) &&
    (c.cost as number) > 0 &&
    num(c.value) &&
    (c.start === null || num(c.start)) &&
    num(c.end) &&
    Array.isArray(c.points) &&
    c.points.length > 0 &&
    c.points.length <= 500 &&
    c.points.every((x) => num(x) && (x as number) > 0) &&
    (c.supply === null || num(c.supply));
  return ok ? (v as PnlCard) : null;
}
