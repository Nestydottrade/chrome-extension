import { describe, expect, it } from 'vitest';
import {
  TrackerError,
  TrackerWatcher,
  type EvmReader,
  type SolReader,
  type TrackerDeps,
} from '../src/background/tracker';
import { trackNote, tradeText } from '../src/background/tracker-notes';
import {
  TRANSFER_TOPIC,
  coinsFromFeed,
  evmMoves,
  evmTrade,
  solTrade,
  type EvmLog,
  type SolTxJson,
} from '../src/background/tracker-parse';
import { WSOL_MINT, USDC_MINT } from '../src/background/solana/address';
import { getChain } from '../src/shared/chains';
import { MAX_FOLLOWED, type TrackedTrade } from '../src/shared/tracker';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const SITE = 'http://localhost:5173';
const BASE = 8453;
const base = getChain(BASE)!;
const WETH = base.wrappedNative.toLowerCase();
const USDC_BASE = base.stablecoins[0]!.address.toLowerCase();
// Made up for the tests: no real wallet's or coin's addresses.
const OWNER = 'Fo11ower11111111111111111111111111111111111';
const ATA = 'Account' + '1'.repeat(37);
const POOL = 'Poo1' + '1'.repeat(40);
const MINT = 'Coin1111111111111111111111111111111111111111';
const EVM_WALLET = '0x00000000000000000000000000000000000A11CE';
const W = EVM_WALLET.toLowerCase();
const COIN = '0x00000000000000000000000000000000000070c0';
const PAIR = '0x0000000000000000000000000000000000000fee';
const T0 = 1_700_000_000_000;

class Memory {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
}

type TokenBalance = NonNullable<NonNullable<SolTxJson['meta']>['preTokenBalances']>[number];

const ownTokens = (
  index: number,
  mint: string,
  amount: bigint,
  decimals: number,
): TokenBalance => ({
  accountIndex: index,
  mint,
  owner: OWNER,
  uiTokenAmount: { amount: String(amount), decimals },
});

/** A Solana transaction by OWNER (the fee payer) that moves `coin` and `lamports` for it. */
function solTx(o: {
  coin?: [before: bigint, after: bigint];
  lamports: bigint;
  stable?: [before: bigint, after: bigint];
  at?: number;
  err?: unknown;
}): SolTxJson {
  const fee = 5_000;
  const rent = 2_039_280;
  const [cb, ca] = o.coin ?? [0n, 0n];
  const opened = cb === 0n && ca > 0n;
  const closed = cb > 0n && ca === 0n;
  // The owner pays the trade and the fee; a token account it opens takes rent from it.
  const owner =
    10_000_000_000 + Number(o.lamports) - fee - (opened ? rent : 0) + (closed ? rent : 0);
  const pre: TokenBalance[] = [];
  const post: TokenBalance[] = [];
  if (cb > 0n) pre.push(ownTokens(1, MINT, cb, 6));
  if (ca > 0n) post.push(ownTokens(1, MINT, ca, 6));
  if (o.stable) {
    pre.push(ownTokens(3, USDC_MINT, o.stable[0], 6));
    post.push(ownTokens(3, USDC_MINT, o.stable[1], 6));
  }
  return {
    blockTime: Math.floor((o.at ?? T0) / 1000),
    meta: {
      err: o.err ?? null,
      fee,
      preBalances: [10_000_000_000, opened ? 0 : rent, 0, rent],
      postBalances: [owner, closed ? 0 : rent, 0, rent],
      preTokenBalances: pre,
      postTokenBalances: post,
    },
    transaction: { message: { accountKeys: [OWNER, ATA, POOL, 'Usdc' + '1'.repeat(40)] } },
  };
}

describe('reading a trade from a transaction', () => {
  it('Solana: a buy and a sell in SOL, fees and rent not counted', () => {
    expect(solTrade(solTx({ coin: [0n, 1_000_000_000n], lamports: -500_000_000n }), OWNER)).toEqual(
      {
        side: 'buy',
        token: MINT,
        raw: 1_000_000_000n,
        decimals: 6,
        native: 500_000_000n,
        stableUsd: null,
      },
    );
    expect(solTrade(solTx({ coin: [1_000_000_000n, 0n], lamports: 650_000_000n }), OWNER)).toEqual({
      side: 'sell',
      token: MINT,
      raw: 1_000_000_000n,
      decimals: 6,
      native: 650_000_000n,
      stableUsd: null,
    });
  });

  it('Solana: paid in a stablecoin', () => {
    const tx = solTx({ coin: [0n, 2_000_000n], lamports: 0n, stable: [80_000_000n, 30_000_000n] });
    expect(solTrade(tx, OWNER)).toMatchObject({ side: 'buy', native: null, stableUsd: 50 });
  });

  it('Solana: a transfer, a failed transaction or another wallet is no trade', () => {
    expect(solTrade(solTx({ coin: [5_000_000n, 1_000_000n], lamports: 0n }), OWNER)).toBeNull();
    const failed = solTx({ coin: [0n, 1_000_000n], lamports: -1_000_000n, err: { Custom: 1 } });
    expect(solTrade(failed, OWNER)).toBeNull();
    const bought = solTx({ coin: [0n, 1_000_000n], lamports: -1_000_000n });
    expect(solTrade(bought, 'Someone' + '1'.repeat(37))).toBeNull();
  });

  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const transfer = (token: string, from: string, to: string, amount: bigint): EvmLog => ({
    address: token,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
  });

  it('EVM: a buy paid in ETH, a sell for WETH, a buy in USDC', () => {
    const buy = evmMoves([transfer(COIN, PAIR, EVM_WALLET, 10n ** 21n)], EVM_WALLET);
    expect(evmTrade(base, buy, -(10n ** 17n))).toEqual({
      side: 'buy',
      token: COIN,
      raw: 10n ** 21n,
      decimals: null,
      native: 10n ** 17n,
      stableUsd: null,
    });
    const sell = evmMoves(
      [
        transfer(COIN, EVM_WALLET, PAIR, 5n * 10n ** 20n),
        transfer(WETH, PAIR, EVM_WALLET, 2n * 10n ** 16n),
      ],
      EVM_WALLET,
    );
    expect(evmTrade(base, sell, 0n)).toMatchObject({ side: 'sell', native: 2n * 10n ** 16n });
    const usdc = evmMoves(
      [
        transfer(USDC_BASE, EVM_WALLET, PAIR, 25_000_000n),
        transfer(COIN, PAIR, EVM_WALLET, 10n ** 18n),
      ],
      EVM_WALLET,
    );
    expect(evmTrade(base, usdc, -3n)).toMatchObject({ side: 'buy', native: null, stableUsd: 25 });
  });

  it('EVM: a claim, a transfer out or two coins at once is no trade', () => {
    const claim = evmMoves([transfer(COIN, PAIR, EVM_WALLET, 10n ** 18n)], EVM_WALLET);
    // A fee's rounding is not a payment.
    expect(evmTrade(base, claim, -40n)).toBeNull();
    const out = evmMoves([transfer(COIN, EVM_WALLET, PAIR, 10n ** 18n)], EVM_WALLET);
    expect(evmTrade(base, out, 0n)).toBeNull();
    const lp = evmMoves(
      [
        transfer(COIN, EVM_WALLET, PAIR, 10n ** 18n),
        transfer('0x0000000000000000000000000000000000000c01', PAIR, EVM_WALLET, 10n ** 18n),
      ],
      EVM_WALLET,
    );
    expect(evmTrade(base, lp, -(10n ** 17n))).toBeNull();
  });
});

const solPairs = (coinPrice: string, coinCap: number) => [
  { baseToken: { address: WSOL_MINT, symbol: 'SOL' }, priceUsd: '150', liquidity: { usd: 1e8 } },
  {
    baseToken: { address: MINT, symbol: 'DEGEN' },
    priceUsd: coinPrice,
    marketCap: coinCap,
    liquidity: { usd: 5e4 },
  },
];

interface Setup {
  sol?: SolReader;
  evm?: EvmReader;
  feed?: (url: string) => unknown;
}

function setup(o: Setup = {}) {
  let n = 0;
  let t = T0 + 60_000;
  const notes: { id: string; title: string; message: string; buttons: string[] }[] = [];
  const scheduled: boolean[] = [];
  const d: TrackerDeps = {
    local: new Memory(),
    fetchJson: async (url) => (o.feed ? o.feed(url) : []),
    notify: async (id, title, message, buttons) => {
      notes.push({ id, title, message, buttons });
    },
    blocked: async () => false,
    schedule: async (on) => {
      scheduled.push(on);
    },
    sol: async () => o.sol ?? { signatures: async () => [], transaction: async () => null },
    evm: async (chainId) => (chainId === BASE ? (o.evm ?? null) : null),
    evmChains: () => [BASE],
    newId: () => `w${++n}`,
    now: () => t,
  };
  const w = new TrackerWatcher(d);
  return { w, notes, scheduled, tick: (ms: number) => (t += ms), now: () => t };
}

/** A Solana wallet whose signatures (newest first) and transactions the test adds to. */
function solChain() {
  const sigs: { sig: string; at: number }[] = [];
  const txs = new Map<string, SolTxJson>();
  const reader: SolReader = {
    async signatures(_address, limit, until) {
      const end = until ? sigs.findIndex((s) => s.sig === until) : -1;
      return (end >= 0 ? sigs.slice(0, end) : sigs)
        .slice(0, limit)
        .map((s) => ({ sig: s.sig, failed: false, at: s.at }));
    },
    transaction: async (sig) => txs.get(sig) ?? null,
  };
  return {
    reader,
    add(sig: string, tx: SolTxJson) {
      sigs.unshift({ sig, at: (tx.blockTime ?? 0) * 1000 });
      txs.set(sig, tx);
    },
  };
}

describe('wallet tracker', () => {
  it('follows a wallet once per site, named, up to the cap', async () => {
    const { w, scheduled } = setup();
    const v = await w.follow(SITE, { address: ` ${EVM_WALLET} `, name: ' Curve‮ sniper ' });
    expect(v.wallets).toEqual([
      { id: 'w1', kind: 'evm', address: W, name: 'Curve sniper', alerts: true, at: T0 + 60_000 },
    ]);
    expect(scheduled).toEqual([true]);
    // Twice: kept once, and a name given renames it.
    const again = await w.follow(SITE, { address: EVM_WALLET, name: 'Whale' });
    expect(again.wallets.map((x) => [x.id, x.name])).toEqual([['w1', 'Whale']]);
    await expect(w.follow(SITE, { address: 'not-an-address' })).rejects.toThrow(TrackerError);

    for (let i = 1; i < MAX_FOLLOWED; i++)
      await w.follow(SITE, { address: `0x${String(i).padStart(40, '0')}` });
    await expect(w.follow(SITE, { address: OWNER })).rejects.toMatchObject({
      code: 'too_many_wallets',
    });

    await w.removeSite(SITE);
    expect((await w.feed(SITE)).wallets).toEqual([]);
    expect(scheduled).toEqual([true, false]);
  });

  it('shows a Solana wallet’s latest trades at once, and notifies only new ones', async () => {
    const chain = solChain();
    chain.add('sig1', solTx({ coin: [0n, 1_000_000_000n], lamports: -500_000_000n, at: T0 }));
    chain.add('sig2', solTx({ coin: [9_000_000n, 1_000_000n], lamports: 0n, at: T0 + 1_000 }));
    const { w, notes, tick, now } = setup({
      sol: chain.reader,
      feed: (url) => (url.includes('/solana/') ? solPairs('0.075', 75_000) : []),
    });
    await w.follow(SITE, { address: OWNER, name: 'Curve sniper' });
    await w.check();
    const first = await w.feed(SITE);
    // The transfer is no trade; the buy is shown with what it was worth, but not notified.
    expect(first.trades).toEqual([
      {
        id: `${SOLANA_CHAIN_ID}:sig1`,
        wallet: OWNER,
        chainId: SOLANA_CHAIN_ID,
        hash: 'sig1',
        at: T0,
        side: 'buy',
        token: MINT,
        tokens: 1_000,
        native: 0.5,
        usd: 75,
        symbol: 'DEGEN',
        // $0.075 a coin, with a million of them.
        mcap: 75_000,
      },
    ]);
    expect(notes).toEqual([]);

    tick(30_000);
    chain.add(
      'sig3',
      solTx({ coin: [1_000_000_000n, 0n], lamports: 2_400_000_000n, at: now() - 5_000 }),
    );
    await w.check();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'Curve sniper sold DEGEN',
      message: '2.40 SOL ($360) at $360K MC on Solana',
      buttons: ['Open coin', 'Mute Curve sniper'],
    });
    expect(trackNote(notes[0]!.id)).toEqual({
      page: `${SITE}/#/token/solana/${MINT}`,
      walletId: 'w1',
      origin: SITE,
    });
    expect((await w.feed(SITE)).trades.map((x) => x.hash)).toEqual(['sig3', 'sig1']);

    // Below the site's minimum, or muted: shown, not notified.
    await w.setMinUsd(SITE, 1_000);
    tick(30_000);
    chain.add(
      'sig4',
      solTx({ coin: [0n, 1_000_000n], lamports: -600_000_000n, at: now() - 5_000 }),
    );
    await w.check();
    await w.setMinUsd(SITE, 0);
    await w.mute(SITE, 'w1');
    tick(30_000);
    chain.add(
      'sig5',
      solTx({ coin: [0n, 1_000_000n], lamports: -600_000_000n, at: now() - 5_000 }),
    );
    await w.check();
    expect(notes).toHaveLength(1);
    const view = await w.feed(SITE);
    expect(view.trades.map((x) => x.hash)).toEqual(['sig5', 'sig4', 'sig3', 'sig1']);
    expect(view.wallets[0]?.alerts).toBe(false);

    // Unfollowed: its trades are forgotten with it.
    await w.unfollow(SITE, 'w1');
    await w.check();
    expect((await w.feed(SITE)).trades).toEqual([]);
  });

  it('finds an EVM wallet’s new transaction by its sent count, and what it paid', async () => {
    const ETH = 10n ** 18n;
    let head = 100n;
    // By the end of a block: [sent, balance].
    const history: [bigint, number, bigint][] = [[0n, 5, ETH]];
    const at = (b: bigint) => [...history].reverse().find(([block]) => block <= b)!;
    const asked: bigint[] = [];
    const hash = `0x${'ab'.repeat(32)}`;
    const reader: EvmReader = {
      head: async () => head,
      balances: async (_a, b) => [at(b)[2]],
      nonce: async (_a, b) => {
        asked.push(b);
        return at(b)[1];
      },
      block: async (b) => ({
        at: T0 + Number(b) * 1000,
        txs:
          b === 107n
            ? [
                { hash: `0x${'cd'.repeat(32)}`, from: PAIR, value: 0n },
                { hash, from: W, value: ETH / 10n },
              ]
            : [],
      }),
      receipt: async (h) =>
        h === hash
          ? {
              ok: true,
              fee: ETH / 10_000n,
              logs: [
                {
                  address: COIN,
                  topics: [
                    TRANSFER_TOPIC,
                    `0x${PAIR.slice(2).padStart(64, '0')}`,
                    `0x${W.slice(2).padStart(64, '0')}`,
                  ],
                  data: `0x${(1_000n * ETH).toString(16)}`,
                },
              ],
            }
          : null,
      decimals: async () => 18,
    };
    const { w, notes, tick } = setup({
      evm: reader,
      feed: (url) =>
        url.includes('/base/')
          ? [
              {
                baseToken: { address: WETH, symbol: 'WETH' },
                priceUsd: '3000',
                liquidity: { usd: 1e8 },
              },
              {
                baseToken: { address: COIN, symbol: 'BASED' },
                priceUsd: '0.3',
                marketCap: 300_000,
              },
            ]
          : [],
    });
    await w.follow(SITE, { address: EVM_WALLET, name: 'Alice' });
    await w.check();
    // First sight: from here on, nothing before.
    expect((await w.feed(SITE)).trades).toEqual([]);

    tick(30_000);
    head = 120n;
    // Block 107: 0.1 ETH and the fee out, a thousand coins in.
    history.push([107n, 6, ETH - ETH / 10n - ETH / 10_000n]);
    // Block 109: some ETH received (no transaction of its own).
    history.push([109n, 6, ETH - ETH / 10n - ETH / 10_000n + ETH / 100n]);
    await w.check();
    const [trade] = (await w.feed(SITE)).trades;
    expect(trade).toMatchObject({
      id: `${BASE}:${hash}`,
      chainId: BASE,
      at: T0 + 107_000,
      side: 'buy',
      token: COIN,
      tokens: 1_000,
      native: 0.1,
      usd: 300,
      symbol: 'BASED',
      mcap: 300_000,
    });
    // Found by halving the blocks between the last look and now.
    expect(asked.filter((b) => b > 100n && b < 120n).length).toBeLessThanOrEqual(6);
    expect(notes.map((x) => [x.title, x.message])).toEqual([
      ['Alice bought BASED', '0.10 ETH ($300) at $300K MC on Base'],
    ]);
  });
});

describe('tracker texts', () => {
  const trade: TrackedTrade = {
    id: '1',
    wallet: OWNER,
    chainId: SOLANA_CHAIN_ID,
    hash: 'sig',
    at: T0,
    side: 'buy',
    token: MINT,
    tokens: 1_234,
    native: 2.4,
    usd: 412,
    symbol: 'AAPLCAT',
    mcap: 84_200,
  };

  it('says who traded what, for how much, at what market cap', () => {
    expect(tradeText({ name: 'Curve sniper', address: OWNER }, trade)).toEqual({
      title: 'Curve sniper bought AAPLCAT',
      message: '2.40 SOL ($412) at $84.2K MC on Solana',
    });
    const bare = { ...trade, chainId: BASE, native: null, usd: null, symbol: null, mcap: null };
    expect(tradeText({ name: '', address: W }, bare)).toEqual({
      title: '0x00…11ce bought Coin…1111',
      message: '1.23K Coin…1111 on Base',
    });
  });

  it('opens coins only on a Nesty site', () => {
    expect(trackNote(`track|w1|${SOLANA_CHAIN_ID}|${MINT}|sig|https://example.com`)).toBeNull();
    expect(trackNote(`alert|w1|${SOLANA_CHAIN_ID}|${MINT}|sig|${SITE}`)).toBeNull();
    expect(trackNote(`track|w1|${BASE}|${COIN.toUpperCase()}|0x1|${SITE}`)).toBeNull();
  });

  it('reads symbol, price and market cap from the most liquid pair', () => {
    const coins = coinsFromFeed(
      BASE,
      [COIN],
      [
        {
          baseToken: { address: COIN, symbol: 'OLD' },
          priceUsd: '1',
          fdv: 10,
          liquidity: { usd: 5 },
        },
        {
          baseToken: { address: `0x${COIN.slice(2).toUpperCase()}`, symbol: 'NEW' },
          priceUsd: '2',
          fdv: 20,
          liquidity: { usd: 9 },
        },
        { baseToken: { address: WETH, symbol: 'WETH' }, priceUsd: '3000' },
      ],
    );
    expect([...coins]).toEqual([[COIN, { symbol: 'NEW', priceUsd: 2, mcap: 20 }]]);
  });
});
