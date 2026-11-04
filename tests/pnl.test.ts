import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { TicketLeg, TradeTicket } from '../src/shared/panel';
import {
  costBasis,
  initialsShare,
  pnlSummary,
  profitOverTime,
  realizedSells,
  unrealisedPnl,
} from '../src/shared/pnl';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const TOKEN = '0x02077a5C3E57Ef3f48B0756E310fcD803Fe67777' as Address;
const E18 = 10n ** 18n;
let n = 0;

const ticket = (
  kind: 'buy' | 'sell',
  legs: Partial<TicketLeg>[],
  extra: Partial<TradeTicket> = {},
) =>
  ({
    id: `t${n++}`,
    kind,
    chainId: 56,
    token: TOKEN,
    status: 'done',
    createdAt: n,
    explorer: '',
    legs: legs.map((l) => ({
      walletId: 'w1',
      walletName: 'Wallet 1',
      kind: 'swap',
      status: 'confirmed',
      ...l,
    })),
    ...extra,
  }) as TradeTicket;

/** Stored newest first, as the activity log keeps it. */
const log = (...oldestFirst: TradeTicket[]) => [...oldestFirst].reverse();

describe('cost basis', () => {
  it('averages buys and takes sells out at the average cost', () => {
    const basis = costBasis(
      log(
        ticket('buy', [
          { amountIn: parseEther('1').toString(), amountOut: (100n * E18).toString() },
        ]),
        ticket('buy', [
          { amountIn: parseEther('3').toString(), amountOut: (100n * E18).toString() },
        ]),
        ticket('sell', [
          { amountIn: (50n * E18).toString(), amountOut: parseEther('5').toString() },
        ]),
      ),
      56,
      TOKEN,
    );
    // 200 tokens for 4 native; selling 50 takes out a quarter of the cost.
    expect(basis.get('w1')).toEqual({ tokens: 150n * E18, costWei: parseEther('3') });
  });

  it('counts only confirmed trades of this token on this chain, per wallet', () => {
    const buy = { amountIn: parseEther('1').toString(), amountOut: (10n * E18).toString() };
    const basis = costBasis(
      log(
        ticket('buy', [buy, { ...buy, walletId: 'w2' }]),
        ticket('buy', [{ ...buy, status: 'failed' }]),
        ticket('buy', [buy], { chainId: 8453 }),
        ticket('buy', [buy], { token: '0x0000000000000000000000000000000000000001' }),
        ticket('buy', [{ ...buy, kind: 'approve' }]),
      ),
      56,
      TOKEN,
    );
    expect(basis.get('w1')).toEqual({ tokens: 10n * E18, costWei: parseEther('1') });
    expect(basis.get('w2')).toEqual({ tokens: 10n * E18, costWei: parseEther('1') });
  });

  it('takes the native paid from the first step of a two-transaction funded buy', () => {
    const basis = costBasis(
      log(
        ticket('buy', [
          { kind: 'step', amountIn: parseEther('0.5').toString() },
          // Paid in the curve's asset, not native.
          { amountIn: (900n * E18).toString(), amountOut: (40n * E18).toString() },
        ]),
      ),
      56,
      TOKEN,
    );
    expect(basis.get('w1')).toEqual({ tokens: 40n * E18, costWei: parseEther('0.5') });
  });

  it('keeps to one pay currency when asked: a coin bought with a token, then with SOL', () => {
    const MINT = 'CDKbv7orjdM8aZuYLWqcNR7ZsttRhaSxgagYw7t6pump';
    const AAPLX = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
    const sol = { chainId: SOLANA_CHAIN_ID, mint: MINT };
    const history = log(
      ticket('buy', [{ amountIn: '50000000', amountOut: '1000' }], {
        ...sol,
        pay: { mint: AAPLX, symbol: 'AAPLx', decimals: 8, stable: false },
      }),
      ticket('buy', [{ amountIn: '2000000000', amountOut: '3000' }], sol),
    );
    expect(costBasis(history, SOLANA_CHAIN_ID, MINT, null).get('w1')).toEqual({
      tokens: 3000n,
      costWei: 2_000_000_000n,
    });
    expect(costBasis(history, SOLANA_CHAIN_ID, MINT, AAPLX).get('w1')).toEqual({
      tokens: 1000n,
      costWei: 50_000_000n,
    });
    // Without one, every trade counts, as on EVM chains (where none has a pay currency).
    expect(costBasis(history, SOLANA_CHAIN_ID, MINT).get('w1')?.tokens).toBe(4000n);
  });
});

describe('unrealised PnL', () => {
  const cost = { tokens: (100n * E18).toString(), costWei: parseEther('1').toString() };

  it('values the held tokens against their cost', () => {
    // 100 tokens for 1 native ($600); now $7 each: $700.
    const up = unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, 7, 600);
    expect(up?.usd).toBeCloseTo(100);
    expect(up?.bps).toBe(1_667);
    const down = unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, 3, 600);
    expect(down?.usd).toBeCloseTo(-300);
    expect(down?.bps).toBe(-5_000);
  });

  it('counts only what is still held of what was bought through Nesty', () => {
    // Half sent away: half the cost remains. Extra tokens from elsewhere carry no cost.
    const half = unrealisedPnl([{ token: (50n * E18).toString(), cost }], 18, 6, 600);
    expect(half?.usd).toBeCloseTo(0);
    const more = unrealisedPnl([{ token: (500n * E18).toString(), cost }], 18, 7, 600);
    expect(more?.usd).toBeCloseTo(100);
  });

  it('shows nothing without a cost basis or a price', () => {
    expect(unrealisedPnl([{ token: (5n * E18).toString() }], 18, 7, 600)).toBeNull();
    expect(unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, null, 600)).toBeNull();
  });
});

describe('sell initials', () => {
  const cost = { tokens: (100n * E18).toString(), costWei: parseEther('1').toString() };
  const held = (n: bigint) => [{ token: (n * E18).toString(), cost }];

  it('sells the share worth what the tokens cost, rounded up', () => {
    // 100 tokens for 1 native ($600), now $8 each: $800, so 75% is worth the $600.
    expect(initialsShare(held(100n), 18, 8, 600)).toEqual({ bps: 7_500, costUsd: 600 });
    // $7 each: 600 / 700 is 85.71…%.
    expect(initialsShare(held(100n), 18, 7, 600)?.bps).toBe(8_572);
    // Tokens from elsewhere are sold from too: 200 held, the 100 bought cost $600.
    expect(initialsShare(held(200n), 18, 6, 600)?.bps).toBe(5_000);
    // Far up, a sliver.
    expect(initialsShare(held(100n), 18, 60_000, 600)?.bps).toBe(1);
  });

  it('offers nothing at cost, at a loss, or without a cost or a price', () => {
    expect(initialsShare(held(100n), 18, 6, 600)).toBeNull();
    expect(initialsShare(held(100n), 18, 3, 600)).toBeNull();
    expect(initialsShare([{ token: (5n * E18).toString() }], 18, 7, 600)).toBeNull();
    expect(initialsShare(held(100n), 18, null, 600)).toBeNull();
    expect(initialsShare(held(100n), 18, 8, null)).toBeNull();
  });
});

describe('realized PnL', () => {
  const tokens = (v: bigint) => (v * E18).toString();

  it('counts each sell against the average cost, in dollars at its own price', () => {
    const sells = realizedSells(
      log(
        ticket('buy', [{ amountIn: parseEther('1').toString(), amountOut: tokens(100n) }]),
        ticket('buy', [{ amountIn: parseEther('3').toString(), amountOut: tokens(100n) }]),
        ticket('sell', [{ amountIn: tokens(50n), amountOut: parseEther('2').toString() }], {
          nativeUsd: 600,
        }),
      ),
    );
    expect(sells).toHaveLength(1);
    // 50 of 200 tokens cost a quarter of 4 native: 1 native for 2, so 1 native made.
    expect(sells[0]).toMatchObject({
      token: TOKEN.toLowerCase(),
      proceeds: parseEther('2'),
      cost: parseEther('1'),
      usd: 600,
    });
  });

  it('counts only the tokens bought here, and leaves out sells with nothing on record', () => {
    const sells = realizedSells(
      log(
        ticket('sell', [{ amountIn: tokens(10n), amountOut: parseEther('1').toString() }]),
        ticket('buy', [{ amountIn: parseEther('1').toString(), amountOut: tokens(100n) }]),
        // Sells 200, of which 100 were bought here: half the proceeds count.
        ticket('sell', [{ amountIn: tokens(200n), amountOut: parseEther('4').toString() }]),
      ),
    );
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ proceeds: parseEther('2'), cost: parseEther('1'), usd: null });
  });

  it('takes a funded curve sell from the step back to the native coin, if it landed', () => {
    const buy = ticket('buy', [{ amountIn: parseEther('1').toString(), amountOut: tokens(100n) }]);
    const sold = ticket('sell', [
      { amountIn: tokens(50n), amountOut: '777' },
      { kind: 'step', amountIn: '777', amountOut: parseEther('3').toString() },
    ]);
    const stuck = ticket('sell', [
      { amountIn: tokens(50n), amountOut: '777' },
      { kind: 'step', status: 'failed' },
    ]);
    const sells = realizedSells(log(buy, sold, stuck));
    expect(sells.map((s) => [s.proceeds, s.cost])).toEqual([[parseEther('3'), parseEther('0.5')]]);
  });

  it('keeps each pay currency and each wallet apart', () => {
    const MINT = 'CDKbv7orjdM8aZuYLWqcNR7ZsttRhaSxgagYw7t6pump';
    const sol = { chainId: SOLANA_CHAIN_ID, mint: MINT };
    const usdc = {
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      decimals: 6,
      stable: true,
    };
    const sells = realizedSells(
      log(
        ticket('buy', [{ amountIn: '1000000000', amountOut: '1000' }], sol),
        // Paid in USDC: no USDC cost on record, so no figure.
        ticket('sell', [{ amountIn: '500', amountOut: '90000000' }], { ...sol, pay: usdc }),
        ticket('sell', [{ amountIn: '500', amountOut: '2000000000', walletId: 'w2' }], sol),
        ticket('sell', [{ amountIn: '500', amountOut: '2000000000' }], { ...sol, nativeUsd: 150 }),
      ),
    );
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({
      token: MINT,
      unit: null,
      proceeds: 2_000_000_000n,
      cost: 500_000_000n,
      usd: 225,
    });
  });

  it('sums the dollars and counts the coins that made money', () => {
    const at = (token: string, usd: number | null) => ({
      id: token,
      chainId: 56,
      token,
      symbol: undefined,
      at: 0,
      unit: null,
      proceeds: 0n,
      cost: 0n,
      usd,
    });
    expect(pnlSummary([at('a', 5), at('a', -2), at('b', -1), at('c', null)])).toEqual({
      usd: 2,
      coins: 2,
      wins: 1,
    });
  });
});

describe('profit over time', () => {
  const sell = (atMs: number, usd: number | null) => ({
    id: String(atMs),
    chainId: 56,
    token: 'a',
    symbol: undefined,
    at: atMs,
    unit: null,
    proceeds: 0n,
    cost: 0n,
    usd,
  });

  it('adds up the priced sells, oldest first, from 0 at the first trade', () => {
    const steps = profitOverTime(
      [sell(9_000, 5), sell(5_500, -2), sell(7_000, null), sell(12_250, 1.5)],
      1_000,
    );
    expect(steps).toEqual([
      { time: 1, usd: 0 },
      { time: 5, usd: -2 },
      { time: 9, usd: 3 },
      { time: 12, usd: 4.5 },
    ]);
  });

  it('makes one step of the sells in the same second', () => {
    expect(profitOverTime([sell(4_100, 2), sell(4_900, 3)], 1_000)).toEqual([
      { time: 1, usd: 0 },
      { time: 4, usd: 5 },
    ]);
  });

  it('starts at the first sell when no earlier trade is known', () => {
    expect(profitOverTime([sell(3_000, 1)])).toEqual([{ time: 3, usd: 1 }]);
    expect(profitOverTime([sell(3_000, 1)], 3_400)).toEqual([{ time: 3, usd: 1 }]);
  });

  it('is empty without a priced sell', () => {
    expect(profitOverTime([])).toEqual([]);
    expect(profitOverTime([sell(1_000, null)], 0)).toEqual([]);
  });
});
