import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { handleMessage } from '../src/background/router';
import { RequestSchema } from '../src/shared/messages';
import type { TicketLeg, TradeTicket } from '../src/shared/panel';
import {
  amountText,
  cardMcap,
  cardPnl,
  heldFor,
  openCard,
  positionTrail,
  readCard,
  signedPercent,
  soldCard,
  type PnlCard,
} from '../src/shared/pnl-card';
import { realizedSells, unrealisedPnl } from '../src/shared/pnl';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const TOKEN = '0x02077a5C3E57Ef3f48B0756E310fcD803Fe67777' as Address;
const MINT = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const E18 = 10n ** 18n;
const MIN = 60_000;
let n = 0;

const ticket = (
  kind: 'buy' | 'sell',
  at: number,
  legs: Partial<TicketLeg>[],
  extra: Partial<TradeTicket> = {},
) =>
  ({
    id: `t${n++}`,
    kind,
    chainId: 56,
    token: TOKEN,
    symbol: 'CAT',
    decimals: 18,
    status: 'done',
    createdAt: at,
    explorer: '',
    nativeUsd: 600,
    legs: legs.map((l) => ({
      walletId: 'w1',
      walletName: 'Wallet 1',
      kind: 'swap',
      status: 'confirmed',
      ...l,
    })),
    ...extra,
  }) as TradeTicket;

/** A buy on Solana, by mint, paid in SOL or in `pay`. */
const solBuy = (at: number, paid: string, got: string, pay?: TradeTicket['pay']) =>
  ({
    id: `t${n++}`,
    kind: 'buy',
    chainId: SOLANA_CHAIN_ID,
    mint: MINT,
    symbol: 'CAT',
    decimals: 6,
    status: 'done',
    createdAt: at,
    explorer: '',
    legs: [
      {
        walletId: 'w1',
        walletName: 'Wallet 1',
        kind: 'swap',
        status: 'confirmed',
        amountIn: paid,
        amountOut: got,
      },
    ],
    ...(pay && { pay }),
  }) as TradeTicket;

/** Stored newest first, as the activity log keeps it. */
const log = (...oldestFirst: TradeTicket[]) => [...oldestFirst].reverse();

/** A buy of `tokens` for `bnb`, or a sell of `tokens` for `bnb`. */
const buy = (at: number, bnb: string, tokens: bigint, wallet = 'w1') =>
  ticket('buy', at, [
    {
      walletId: wallet,
      amountIn: parseEther(bnb).toString(),
      amountOut: (tokens * E18).toString(),
    },
  ]);
const sell = (at: number, tokens: bigint, bnb: string, wallet = 'w1') =>
  ticket('sell', at, [
    {
      walletId: wallet,
      amountIn: (tokens * E18).toString(),
      amountOut: parseEther(bnb).toString(),
    },
  ]);

const BNB = { symbol: 'BNB', decimals: 18, mint: null, usd: 600 };

describe('the card of an open position', () => {
  it('says what the position pill says, from the buy that opened it', () => {
    const history = log(buy(1 * MIN, '1', 100n), buy(5 * MIN, '3', 100n));
    const wallets = [
      {
        id: 'w1',
        token: (200n * E18).toString(),
        cost: { tokens: (200n * E18).toString(), costWei: parseEther('4').toString() },
      },
    ];
    const card = openCard({
      chainId: 56,
      token: TOKEN,
      symbol: 'CAT',
      decimals: 18,
      unit: BNB,
      wallets,
      tokenUsd: 30, // 200 tokens: $6,000, against 4 BNB ($2,400) paid.
      supply: 1_000_000,
      history,
      now: 90 * MIN,
    }) as PnlCard;
    expect(card).toMatchObject({ kind: 'open', cost: 4, value: 10, start: 1 * MIN, end: 90 * MIN });
    // The trades' prices in BNB a token, then today's: $30 / $600.
    expect(card.points).toEqual([0.01, 0.03, 0.05]);
    const pnl = cardPnl(card);
    const pill = unrealisedPnl(wallets, 18, 30, 600) as { usd: number; bps: number };
    expect(pnl.usd).toBeCloseTo(pill.usd);
    expect(pnl.bps).toBe(pill.bps);
    expect(signedPercent(pnl.bps)).toBe('+150%');
    // $30 × 1M tokens now; bought on average at 0.4 of today's price.
    expect(cardMcap(card)).toEqual({ from: 12_000_000, to: 30_000_000 });
  });

  it('starts again after everything bought was sold', () => {
    const history = log(
      buy(1 * MIN, '1', 100n),
      sell(2 * MIN, 100n, '2'),
      buy(10 * MIN, '2', 100n),
    );
    const trail = positionTrail(history, {
      chainId: 56,
      token: TOKEN.toLowerCase(),
      unit: null,
      walletIds: ['w1'],
      decimals: 18,
      unitDecimals: 18,
    });
    expect(trail).toEqual({ start: 10 * MIN, points: [0.02] });
  });

  it('follows only the chosen wallets, and a funded buy by what its first step paid', () => {
    const history = log(
      buy(1 * MIN, '1', 100n, 'w2'),
      ticket('buy', 3 * MIN, [
        { kind: 'step', amountIn: parseEther('0.5').toString() },
        { amountIn: (900n * E18).toString(), amountOut: (100n * E18).toString() },
      ]),
    );
    const trail = positionTrail(history, {
      chainId: 56,
      token: TOKEN,
      unit: null,
      walletIds: ['w1'],
      decimals: 18,
      unitDecimals: 18,
    });
    expect(trail).toEqual({ start: 3 * MIN, points: [0.005] });
  });

  it('keeps to the currency the cost is in', () => {
    // 1 SOL for 100 tokens, then 50 USDC for 100 more.
    const inSol = solBuy(1 * MIN, '1000000000', '100000000');
    const inUsdc = solBuy(2 * MIN, '50000000', '100000000', {
      mint: USDC,
      symbol: 'USDC',
      decimals: 6,
      stable: true,
    });
    const p = { chainId: SOLANA_CHAIN_ID, token: MINT, walletIds: ['w1'], decimals: 6 };
    expect(positionTrail(log(inSol, inUsdc), { ...p, unit: USDC, unitDecimals: 6 })).toEqual({
      start: 2 * MIN,
      points: [0.5],
    });
    expect(positionTrail(log(inSol, inUsdc), { ...p, unit: null, unitDecimals: 9 })).toEqual({
      start: 1 * MIN,
      points: [0.01],
    });
  });

  it('is not made without a cost on record or a price', () => {
    const base = {
      chainId: 56,
      token: TOKEN,
      symbol: 'CAT',
      decimals: 18,
      unit: BNB,
      history: [],
      now: 0,
    };
    const held = { id: 'w1', token: (5n * E18).toString() };
    expect(openCard({ ...base, wallets: [held], tokenUsd: 1 })).toBeNull();
    const costed = { ...held, cost: { tokens: (5n * E18).toString(), costWei: '1' } };
    expect(openCard({ ...base, wallets: [costed], tokenUsd: null })).toBeNull();
    expect(
      openCard({ ...base, unit: { ...BNB, usd: null }, wallets: [costed], tokenUsd: 1 }),
    ).toBeNull();
  });
});

describe('the card of a sell', () => {
  it('shows what the sell made against the cost of what it sold', () => {
    const history = log(
      buy(1 * MIN, '1', 100n),
      sell(30 * MIN, 50n, '1.5'),
      buy(40 * MIN, '1', 10n),
    );
    const s = realizedSells(history)[0];
    if (!s) throw new Error('no sell');
    const card = soldCard(s, history, 1_000_000) as PnlCard;
    expect(card).toMatchObject({
      kind: 'sold',
      symbol: 'CAT',
      unit: { symbol: 'BNB', usd: 600 },
      cost: 0.5,
      value: 1.5,
      start: 1 * MIN,
      end: 30 * MIN,
      points: [0.01, 0.03],
    });
    expect(cardPnl(card)).toEqual({ units: 1, usd: 600, bps: 20_000 });
    expect(heldFor(card.end - (card.start ?? 0))).toBe('29m');
    // 0.03 BNB × $600 × 1M tokens at the sell; the entry a third of that.
    const mcap = cardMcap(card) as { from: number; to: number };
    expect(mcap.to).toBeCloseTo(18_000_000);
    expect(mcap.from).toBeCloseTo(6_000_000);
  });

  it('is not made for a ticket the log does not have', () => {
    const history = log(buy(1, '1', 100n), sell(2, 50n, '1.5'));
    const s = realizedSells(history)[0];
    if (!s) throw new Error('no sell');
    expect(soldCard(s, history.slice(1))).toBeNull();
  });
});

describe('card text', () => {
  it('reads as traders write it', () => {
    expect(heldFor(45_000)).toBe('45s');
    expect(heldFor(12 * MIN)).toBe('12m');
    expect(heldFor(2 * 60 * MIN + 14 * MIN)).toBe('2h 14m');
    expect(heldFor(5 * 60 * MIN + 2 * MIN)).toBe('5h 02m');
    expect(heldFor(76 * 60 * MIN)).toBe('3d 4h');
    expect(signedPercent(18_480)).toBe('+184.8%');
    expect(signedPercent(-4_250)).toBe('−42.5%');
    expect(amountText(2.31, 'SOL', true)).toBe('+2.31 SOL');
    expect(amountText(-61.54, null, true)).toBe('−$61.54');
    expect(amountText(226.25, null)).toBe('$226.25');
  });

  it('draws only a card that is whole', () => {
    const card: PnlCard = {
      chainId: 56,
      token: TOKEN,
      symbol: 'CAT',
      decimals: 18,
      kind: 'open',
      unit: { symbol: 'BNB', usd: 600 },
      cost: 1,
      value: 2,
      start: null,
      end: 1,
      points: [0.01, 0.02],
      supply: null,
    };
    expect(readCard(card)).toBe(card);
    expect(readCard({ ...card, cost: 0 })).toBeNull();
    expect(readCard({ ...card, points: [] })).toBeNull();
    expect(readCard({ ...card, points: [0.01, -1] })).toBeNull();
    expect(readCard({ ...card, unit: { symbol: 'BNB' } })).toBeNull();
    expect(readCard({ ...card, kind: 'other' })).toBeNull();
    expect(readCard(null)).toBeNull();
  });
});

describe('the request that opens a card', () => {
  const history = log(buy(1 * MIN, '1', 100n), buy(5 * MIN, '3', 100n));
  const req = {
    type: 'share.open',
    chainId: 56,
    token: TOKEN,
    symbol: 'CAT',
    decimals: 18,
    unit: { symbol: 'BNB', decimals: 18, mint: null, usd: 600 },
    wallets: [
      {
        id: 'w1',
        token: (200n * E18).toString(),
        cost: { tokens: (200n * E18).toString(), costWei: parseEther('4').toString() },
      },
    ],
    tokenUsd: 30,
  };
  const panel = { kind: 'content-script', tabId: 1, origin: 'https://gmgn.ai' } as const;
  const deps = (opened: PnlCard[]) =>
    ({
      history: { list: async () => history },
      now: () => 90 * MIN,
      openShare: async (c: PnlCard) => void opened.push(c),
      vault: { isUnlocked: async () => false },
      onActivity: async () => {},
    }) as never;

  it('opens the card of the figures the panel sends, with the trades from the log', async () => {
    const opened: PnlCard[] = [];
    expect(await handleMessage(req, panel, deps(opened))).toEqual({ ok: true, data: null });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      kind: 'open',
      cost: 4,
      value: 10,
      start: 1 * MIN,
      end: 90 * MIN,
      points: [0.01, 0.03, 0.05],
      supply: null,
    });
    await handleMessage({ ...req, supply: 1_000_000 }, panel, deps(opened));
    expect(opened[1]?.supply).toBe(1_000_000);
  });

  it('is not open to the website, and opens nothing without a cost to show', async () => {
    const opened: PnlCard[] = [];
    expect(await handleMessage(req, { kind: 'nesty-site' }, deps(opened))).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const bought = { ...req, wallets: [{ id: 'w1', token: '5' }] };
    expect(await handleMessage(bought, panel, deps(opened))).toEqual({
      ok: false,
      error: 'internal',
    });
    expect(opened).toHaveLength(0);
  });

  it.each([
    ['a currency without a price', { unit: { ...req.unit, usd: 0 } }],
    ['a mint on an EVM chain', { token: MINT }],
    ['no wallet', { wallets: [] }],
    ['an amount that is not whole', { wallets: [{ id: 'w1', token: '1.5' }] }],
    ['a field it does not know', { site: 'gmgn.ai' }],
  ])('is refused with %s', async (_label, change) => {
    expect(RequestSchema.safeParse({ ...req, ...change }).success).toBe(false);
    expect(await handleMessage({ ...req, ...change }, panel, deps([]))).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('reads the supply of a Solana coin for the market cap', async () => {
    const page = { kind: 'extension-page' } as const;
    const ask = { type: 'token.supply', chainId: SOLANA_CHAIN_ID, token: MINT };
    const d = (tokenMeta: () => Promise<unknown>) =>
      ({
        solana: { tokenMeta },
        vault: { isUnlocked: async () => false },
        onActivity: async () => {},
      }) as never;
    expect(
      await handleMessage(
        ask,
        page,
        d(async () => ({ supply: 10n ** 15n })),
      ),
    ).toEqual({
      ok: true,
      data: '1000000000000000',
    });
    // Unread (a coin seconds old, or the network down): no market cap, and no error.
    expect(
      await handleMessage(
        ask,
        page,
        d(async () => null),
      ),
    ).toEqual({ ok: true, data: null });
    expect(
      await handleMessage(
        ask,
        page,
        d(async () => {
          throw new Error('rpc');
        }),
      ),
    ).toEqual({ ok: true, data: null });
    expect(
      await handleMessage(
        { ...ask, chainId: 56 },
        page,
        d(async () => null),
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });
});
