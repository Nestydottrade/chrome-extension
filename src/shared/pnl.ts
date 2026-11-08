import { formatUnits, isAddressEqual, type Address } from 'viem';
import { getChain } from './chains';
import type { TicketLeg, TradeTicket } from './panel';
import { isSolana } from './solana';

/**
 * Every PnL figure counts a position the same way, at its average cost: a buy adds its tokens
 * and what they cost; a sale takes out tokens at the average cost of those left, and only
 * those the position holds, as what it sold beyond them has no cost on record. The rule comes
 * in two forms, for the two kinds of amount: a wallet's own log holds raw units, counted
 * exactly (`CostBasis`), public trades whole coins, as numbers (`WholePosition`).
 * website/indexer/pnl-compare.test.ts holds everything that counts one to the same answers.
 */

/** What a wallet's Nesty trades left open in a token: tokens and their native cost. */
export interface CostBasis {
  tokens: bigint;
  costWei: bigint;
}

/** A sale out of a position, at its average cost: the tokens it had, and what they cost. */
function takeOut(pos: CostBasis, amount: bigint): { sold: bigint; cost: bigint } {
  const sold = amount < pos.tokens ? amount : pos.tokens;
  const cost = (pos.costWei * sold) / pos.tokens;
  pos.costWei -= cost;
  pos.tokens -= sold;
  return { sold, cost };
}

/** A position in whole coins, its cost in whole units of what they trade against. */
export interface WholePosition {
  held: number;
  cost: number;
  /** Tokens bought since it opened, to tell what is left of them from the crumbs of a sale. */
  bought: number;
}

/** A position this small a part of what was bought is spent. */
export const DUST = 1e-6;

export function buyWhole(p: WholePosition, tokens: number, quote: number): void {
  p.held += tokens;
  p.cost += quote;
  p.bought += tokens;
}

/**
 * A sale of `tokens` for `quote` out of a position: the part it held (`matched`), what those
 * tokens cost, and their share of what the sale fetched.
 */
export function sellWhole(
  p: WholePosition,
  tokens: number,
  quote: number,
): { matched: number; cost: number; fetched: number } {
  if (!(p.held > 0) || !(tokens > 0)) return { matched: 0, cost: 0, fetched: 0 };
  const matched = Math.min(tokens, p.held);
  const cost = (p.cost * matched) / p.held;
  const fetched = (quote * matched) / tokens;
  p.held -= matched;
  p.cost -= cost;
  if (p.held <= p.bought * DUST) {
    p.held = 0;
    p.cost = 0;
    p.bought = 0;
  }
  return { matched, cost, fetched };
}

/** What a ticket did for one wallet, in raw units. */
export interface TicketFill {
  walletId: string;
  /** The tokens a buy got, or a sell gave. */
  tokens: bigint;
  /** What a buy paid; 0 on a sell. */
  paid: bigint;
  /** What a sell fetched: null when not known, as on a buy. */
  fetched: bigint | null;
}

/**
 * Each wallet's confirmed trade in a ticket with known amounts. A funded curve pays in a step
 * before its swap and comes back to the chain's coin in a step after it: those steps count.
 */
export function ticketFills(t: TradeTicket): TicketFill[] {
  const byWallet = new Map<string, TicketLeg[]>();
  for (const l of t.legs) byWallet.set(l.walletId, [...(byWallet.get(l.walletId) ?? []), l]);
  const fills: TicketFill[] = [];
  for (const [walletId, legs] of byWallet) {
    const done = (kind: TicketLeg['kind']) =>
      legs.find((l) => l.kind === kind && l.status === 'confirmed');
    const swap = done('swap');
    if (!swap) continue;
    if (t.kind === 'buy') {
      const paid = done('step')?.amountIn ?? swap.amountIn;
      if (paid && swap.amountOut)
        fills.push({ walletId, tokens: BigInt(swap.amountOut), paid: BigInt(paid), fetched: null });
    } else if (swap.amountIn && BigInt(swap.amountIn) > 0n) {
      const step = legs.some((l) => l.kind === 'step');
      const got = step ? done('step')?.amountOut : swap.amountOut;
      fills.push({
        walletId,
        tokens: BigInt(swap.amountIn),
        paid: 0n,
        fetched: got ? BigInt(got) : null,
      });
    }
  }
  return fills;
}

/** Of what a wallet holds, the part with a cost on record, and what that part cost. */
export function coveredPart(held: bigint, basis: CostBasis): CostBasis {
  if (basis.tokens <= 0n || held <= 0n) return { tokens: 0n, costWei: 0n };
  const tokens = held < basis.tokens ? held : basis.tokens;
  return { tokens, costWei: (basis.costWei * tokens) / basis.tokens };
}

/**
 * Average-cost basis per wallet from the activity log (newest first, as stored): buys add
 * tokens and the native paid, sells take tokens out at their average cost. Only confirmed
 * transactions with known amounts count; gas is left out. Tokens a wallet got outside
 * Nesty have no cost here, so callers value only the part this covers.
 *
 * `unit` keeps only trades paid in one currency, for a Solana coin bought with a token
 * once and with SOL later: null for the native coin, else that token's mint.
 */
export function costBasis(
  history: readonly TradeTicket[],
  chainId: number,
  token: string,
  unit?: string | null,
): Map<string, CostBasis> {
  const out = new Map<string, CostBasis>();
  // Solana mints are base58: compared exactly, never case-folded.
  const same = (t: TradeTicket) =>
    isSolana(chainId) ? t.mint === token : !!t.token && isAddressEqual(t.token, token as Address);
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i] as TradeTicket;
    if (t.chainId !== chainId || !same(t)) continue;
    if (unit !== undefined && (t.pay?.mint ?? null) !== unit) continue;
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    for (const f of ticketFills(t)) {
      const pos = out.get(f.walletId) ?? { tokens: 0n, costWei: 0n };
      if (t.kind === 'buy') {
        pos.tokens += f.tokens;
        pos.costWei += f.paid;
      } else {
        if (pos.tokens === 0n) continue;
        takeOut(pos, f.tokens);
      }
      out.set(f.walletId, pos);
    }
  }
  return out;
}

/**
 * Unrealised profit or loss of the held tokens that have a cost basis, at today's prices
 * (`usd`, and `bps` of the cost). Null when nothing held has one, or a price is missing.
 */
export function unrealisedPnl(
  wallets: readonly { token: string; cost?: { tokens: string; costWei: string } }[],
  decimals: number,
  tokenUsd: number | null,
  nativeUsd: number | null,
  nativeDecimals = 18,
): { usd: number; bps: number; costUsd: number } | null {
  if (!tokenUsd || !nativeUsd) return null;
  let covered = 0n;
  let cost = 0n;
  for (const w of wallets) {
    // Sold or sent elsewhere: only what is still held counts, at its average cost.
    const part = coveredPart(BigInt(w.token), {
      tokens: BigInt(w.cost?.tokens ?? '0'),
      costWei: BigInt(w.cost?.costWei ?? '0'),
    });
    covered += part.tokens;
    cost += part.costWei;
  }
  const costUsd = Number(formatUnits(cost, nativeDecimals)) * nativeUsd;
  if (covered === 0n || costUsd <= 0) return null;
  const usd = Number(formatUnits(covered, decimals)) * tokenUsd - costUsd;
  return { usd, bps: Math.round((usd / costUsd) * 10_000), costUsd };
}

/**
 * Sell initials: the share of the chosen wallets' tokens, in bps and rounded up, that is
 * worth now what the tokens bought through Nesty and still held cost. Null without a cost
 * or a price, or when the holding is worth no more than it cost: it would sell everything.
 */
export function initialsShare(
  wallets: readonly { token: string; cost?: { tokens: string; costWei: string } }[],
  decimals: number,
  tokenUsd: number | null,
  nativeUsd: number | null,
  nativeDecimals = 18,
): { bps: number; costUsd: number } | null {
  const pnl = unrealisedPnl(wallets, decimals, tokenUsd, nativeUsd, nativeDecimals);
  if (!pnl || !tokenUsd) return null;
  const held = wallets.reduce((s, w) => s + BigInt(w.token), 0n);
  const worthUsd = Number(formatUnits(held, decimals)) * tokenUsd;
  if (!(worthUsd > pnl.costUsd)) return null;
  const bps = Math.ceil((pnl.costUsd / worthUsd) * 10_000);
  return { bps: Math.min(10_000, Math.max(1, bps)), costUsd: pnl.costUsd };
}

/** What one sell made, by the average cost of the tokens it sold. */
export interface RealizedSell {
  /** The sell's ticket. */
  id: string;
  chainId: number;
  /** Its coin: the mint on Solana, else the contract, lower-cased. */
  token: string;
  symbol: string | undefined;
  /** Unix ms, when the sell was sent. */
  at: number;
  /** What it was paid in: null for the chain's own coin, else that token's mint. */
  unit: string | null;
  /** Raw units of `unit`: what the tokens sold fetched, and what they had cost. */
  proceeds: bigint;
  cost: bigint;
  /** Proceeds less cost in dollars, at the ticket's price of `unit`; null without one. */
  usd: number | null;
}

/**
 * Every sell's realized profit, oldest first, by the same average cost as `costBasis`: per
 * wallet, coin and currency paid in. Only tokens with a cost on record count; a sell of
 * tokens that came from elsewhere, or whose proceeds are not known (a funded curve's step
 * back to the native coin that did not land), adds no figure, though it still takes the
 * tokens out of the position.
 */
export function realizedSells(history: readonly TradeTicket[]): RealizedSell[] {
  const positions = new Map<string, CostBasis>();
  const out: RealizedSell[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i] as TradeTicket;
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    const coin = isSolana(t.chainId) ? t.mint : t.token?.toLowerCase();
    if (!coin) continue;
    const unit = t.pay?.mint ?? null;
    let proceeds = 0n;
    let cost = 0n;
    let counted = false;
    for (const f of ticketFills(t)) {
      const key = `${t.chainId}|${coin}|${unit ?? ''}|${f.walletId}`;
      const pos = positions.get(key) ?? { tokens: 0n, costWei: 0n };
      positions.set(key, pos);
      if (t.kind === 'buy') {
        pos.tokens += f.tokens;
        pos.costWei += f.paid;
        continue;
      }
      if (pos.tokens === 0n) continue;
      const sale = takeOut(pos, f.tokens);
      if (f.fetched === null) continue;
      proceeds += (f.fetched * sale.sold) / f.tokens;
      cost += sale.cost;
      counted = true;
    }
    if (t.kind !== 'sell' || !counted) continue;
    const decimals =
      t.pay?.decimals ??
      (isSolana(t.chainId) ? 9 : (getChain(t.chainId)?.nativeCurrency.decimals ?? 18));
    out.push({
      id: t.id,
      chainId: t.chainId,
      token: coin,
      symbol: t.symbol,
      at: t.createdAt,
      unit,
      proceeds,
      cost,
      usd:
        t.nativeUsd === undefined
          ? null
          : Number(formatUnits(proceeds - cost, decimals)) * t.nativeUsd,
    });
  }
  return out;
}

/** Realized profit in dollars as it stood after a sell. */
export interface ProfitStep {
  /** Unix seconds. */
  time: number;
  usd: number;
}

/**
 * Realized profit as it built up, oldest first: the total after each sell that has a
 * price, starting from 0 at `from` (unix ms, the first trade) when that came before the
 * first such sell. Sells in the same second make one step.
 */
export function profitOverTime(sells: readonly RealizedSell[], from?: number): ProfitStep[] {
  const priced = sells
    .filter((s): s is RealizedSell & { usd: number } => s.usd !== null && Number.isFinite(s.usd))
    .sort((a, b) => a.at - b.at);
  const first = priced[0];
  if (!first) return [];
  const out: ProfitStep[] = [];
  const start = from === undefined ? null : Math.floor(from / 1000);
  if (start !== null && start < Math.floor(first.at / 1000)) out.push({ time: start, usd: 0 });
  let usd = 0;
  for (const s of priced) {
    usd += s.usd;
    const time = Math.floor(s.at / 1000);
    const last = out.at(-1);
    if (last?.time === time) last.usd = usd;
    else out.push({ time, usd });
  }
  return out;
}

/** Realized profit in all, and how many of the coins sold made money. */
export interface PnlSummary {
  /** Dollars, over the sells that have a price. */
  usd: number;
  /** Coins sold at least once, and those whose sells made money together. */
  coins: number;
  wins: number;
}

export function pnlSummary(sells: readonly RealizedSell[]): PnlSummary {
  const byCoin = new Map<string, number>();
  let usd = 0;
  for (const s of sells) {
    if (s.usd === null) continue;
    usd += s.usd;
    const key = `${s.chainId}|${s.token}`;
    byCoin.set(key, (byCoin.get(key) ?? 0) + s.usd);
  }
  let wins = 0;
  for (const v of byCoin.values()) if (v > 0) wins++;
  return { usd, coins: byCoin.size, wins };
}
