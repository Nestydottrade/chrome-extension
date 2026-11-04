import { formatUnits, isAddressEqual, type Address } from 'viem';
import { getChain } from './chains';
import type { TicketLeg, TradeTicket } from './panel';
import { isSolana } from './solana';

/** What a wallet's Nesty trades left open in a token: tokens and their native cost. */
export interface CostBasis {
  tokens: bigint;
  costWei: bigint;
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
    const byWallet = new Map<string, TicketLeg[]>();
    for (const l of t.legs) byWallet.set(l.walletId, [...(byWallet.get(l.walletId) ?? []), l]);
    for (const [walletId, legs] of byWallet) {
      const done = (kind: TicketLeg['kind']) =>
        legs.find((l) => l.kind === kind && l.status === 'confirmed');
      const swap = done('swap');
      if (!swap) continue;
      const pos = out.get(walletId) ?? { tokens: 0n, costWei: 0n };
      if (t.kind === 'buy') {
        // A funded curve bought in two transactions paid native in its first step.
        const paid = done('step')?.amountIn ?? swap.amountIn;
        if (!paid || !swap.amountOut) continue;
        pos.tokens += BigInt(swap.amountOut);
        pos.costWei += BigInt(paid);
      } else {
        if (!swap.amountIn || pos.tokens === 0n) continue;
        const sold = BigInt(swap.amountIn) < pos.tokens ? BigInt(swap.amountIn) : pos.tokens;
        pos.costWei -= (pos.costWei * sold) / pos.tokens;
        pos.tokens -= sold;
      }
      out.set(walletId, pos);
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
    const tokens = BigInt(w.cost?.tokens ?? '0');
    const held = BigInt(w.token);
    if (tokens <= 0n || held <= 0n) continue;
    // Sold or sent elsewhere: only what is still held counts, at its average cost.
    const part = held < tokens ? held : tokens;
    covered += part;
    cost += (BigInt(w.cost?.costWei ?? '0') * part) / tokens;
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
    const byWallet = new Map<string, TicketLeg[]>();
    for (const l of t.legs) byWallet.set(l.walletId, [...(byWallet.get(l.walletId) ?? []), l]);
    let proceeds = 0n;
    let cost = 0n;
    let counted = false;
    for (const [walletId, legs] of byWallet) {
      const key = `${t.chainId}|${coin}|${unit ?? ''}|${walletId}`;
      const done = (kind: TicketLeg['kind']) =>
        legs.find((l) => l.kind === kind && l.status === 'confirmed');
      const swap = done('swap');
      if (!swap) continue;
      const pos = positions.get(key) ?? { tokens: 0n, costWei: 0n };
      positions.set(key, pos);
      if (t.kind === 'buy') {
        const paid = done('step')?.amountIn ?? swap.amountIn;
        if (!paid || !swap.amountOut) continue;
        pos.tokens += BigInt(swap.amountOut);
        pos.costWei += BigInt(paid);
        continue;
      }
      if (!swap.amountIn || pos.tokens === 0n) continue;
      const amountIn = BigInt(swap.amountIn);
      if (amountIn === 0n) continue;
      const sold = amountIn < pos.tokens ? amountIn : pos.tokens;
      const part = (pos.costWei * sold) / pos.tokens;
      pos.costWei -= part;
      pos.tokens -= sold;
      // A funded curve's sell comes back to the native coin in a step after the swap.
      const step = legs.find((l) => l.kind === 'step');
      const got = step ? done('step')?.amountOut : swap.amountOut;
      if (!got) continue;
      proceeds += (BigInt(got) * sold) / amountIn;
      cost += part;
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
