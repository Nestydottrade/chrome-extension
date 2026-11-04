import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  findProgramAddress,
  seed,
} from '../src/background/solana/address';
import { dexModule, type DexVenue } from '../src/background/solana/dex';
import { dbcPoolAddress } from '../src/background/solana/dex/meteora-dbc';
import {
  METEORA_DLMM_PROGRAM,
  type MeteoraDlmmVenue,
} from '../src/background/solana/dex/meteora-dlmm';
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  sqrtPriceFromTick,
  tickFromSqrtPrice,
} from '../src/background/solana/dex/whirlpool-math';
import { SOL_QUOTE, type Side } from '../src/background/solana/pump';
import { tradeBuilder, validateTrade } from '../src/background/solana/routes';
import { setComputeUnitLimit, setComputeUnitPrice } from '../src/background/solana/spl';
import type { Instruction } from '../src/background/solana/tx';

const address = (name: string) => findProgramAddress([seed(name)], SYSTEM_PROGRAM);
const WALLET = address('nesty-test-wallet');
const MINT = address('nesty-test-mint');
const POOL = address('nesty-test-pool');
const ONE = 1n << 64n;

describe('Orca Whirlpool tick math', () => {
  it('prices the ends and the middle of the tick range as the program does', () => {
    expect(sqrtPriceFromTick(0)).toBe(ONE);
    expect(sqrtPriceFromTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(sqrtPriceFromTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
  });

  it('finds the tick a price falls in, rounding down', () => {
    for (const tick of [MIN_TICK + 1, -100_000, -12_345, -1, 1, 64, 12_345, 100_000, MAX_TICK]) {
      const price = sqrtPriceFromTick(tick);
      expect(tickFromSqrtPrice(price)).toBe(tick);
      expect(tickFromSqrtPrice(price - 1n)).toBe(tick - 1);
    }
  });
});

describe('Meteora DLMM quotes', () => {
  /** One array of coin (token X) above the active bin and SOL below it, at price 1. */
  const venue = (over: Partial<MeteoraDlmmVenue> = {}): MeteoraDlmmVenue => ({
    kind: 'dex',
    dex: 'meteora-dlmm',
    pool: POOL,
    mint: MINT,
    tokenProgram: TOKEN_PROGRAM,
    quote: SOL_QUOTE,
    coinIsX: true,
    reserveX: address('nesty-test-reserve-x'),
    reserveY: address('nesty-test-reserve-y'),
    oracle: address('nesty-test-oracle'),
    status: 0,
    pairType: 0,
    activationType: 1,
    activationPoint: 0n,
    clock: { slot: 1_000n, unixTime: 1_000n },
    binStep: 100,
    activeId: 0,
    // A 1% base fee (10_000 × 100 × 10 of 10^9) and no variable fee.
    fee: {
      baseFactor: 10_000,
      powerFactor: 0,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5_000,
      variableFeeControl: 0,
      maxVolatility: 350_000,
      volatility: 0,
      volatilityReference: 0,
      indexReference: 0,
      lastUpdate: 0n,
    },
    limitOrders: false,
    feeInY: false,
    up: [
      {
        index: 0,
        bins: [
          { id: 0, x: 1_000_000n, y: 0n, price: ONE, orders: null },
          { id: 1, x: 1_000_000n, y: 0n, price: ONE, orders: null },
        ],
      },
    ],
    down: [{ index: -1, bins: [{ id: -1, x: 0n, y: 1_000_000n, price: ONE, orders: null }] }],
    ...over,
  });
  const quote = (v: MeteoraDlmmVenue, side: Side, amount: bigint) =>
    dexModule(v).quote(v, side, amount);

  it('takes the fee off the input within a bin', () => {
    // 1% of 100_000 is 1_000; the rest buys at price 1.
    expect(quote(venue(), 'buy', 100_000n)).toBe(99_000n);
  });

  it('empties a bin for what fills it plus its fee, and goes on to the next', () => {
    // Bin 0 takes 1_000_000 and a fee of ceil(10^13 / 99 × 10^7) = 10_102; the 989_898 left
    // pays 9_899 in fees and buys 979_999 in bin 1.
    expect(quote(venue(), 'buy', 2_000_000n)).toBe(1_979_999n);
  });

  it('crosses the empty stretch to the next array holding liquidity', () => {
    const far = venue({
      up: [{ index: 2, bins: [{ id: 150, x: 1_000_000n, y: 0n, price: ONE, orders: null }] }],
    });
    expect(quote(far, 'buy', 100_000n)).toBe(99_000n);
  });

  it('quotes nothing for a swap past the arrays it read', () => {
    expect(quote(venue(), 'buy', 5_000_000n)).toBe(0n);
    expect(quote(venue({ up: [] }), 'buy', 1_000n)).toBe(0n);
  });

  it('fills limit orders after the market makers', () => {
    const withOrders = venue({
      limitOrders: true,
      up: [
        {
          index: 0,
          bins: [
            {
              id: 0,
              x: 500_000n,
              y: 0n,
              price: ONE,
              orders: { ask: true, open: 300_000n, processed: 200_000n },
            },
          ],
        },
      ],
    });
    // The whole bin, 500_000 of liquidity and 500_000 of asks, fills a 1_000_000 buy's net.
    expect(quote(withOrders, 'buy', 1_000_000n)).toBe(990_000n);
    // Bids do not fill a buy.
    const bids = venue({
      limitOrders: true,
      up: [
        {
          index: 0,
          bins: [
            {
              id: 0,
              x: 500_000n,
              y: 0n,
              price: ONE,
              orders: { ask: false, open: 300_000n, processed: 200_000n },
            },
          ],
        },
      ],
    });
    expect(quote(bids, 'buy', 1_000_000n)).toBe(0n);
  });

  it('takes the fee off the output where the pool collects only token Y', () => {
    // Selling 100_000 of the coin gets 100_000 SOL, less 1%.
    expect(quote(venue({ feeInY: true }), 'sell', 100_000n)).toBe(99_000n);
    expect(quote(venue(), 'sell', 100_000n)).toBe(99_000n);
  });

  it('adds the variable fee as the swap crosses bins', () => {
    // 40_000 × (10_000 × 100)^2 / 10^11 = 400_000 of 10^9 once one bin is crossed.
    const v = venue({ fee: { ...venue().fee, variableFeeControl: 40_000 } });
    const flat = quote(venue(), 'buy', 2_000_000n);
    expect(quote(v, 'buy', 2_000_000n)).toBeLessThan(flat);
    expect(quote(v, 'buy', 100_000n)).toBe(99_000n);
  });

  it('asks for compute by the bins a trade takes liquidity from', () => {
    const v = venue();
    const units = (amount: bigint) => dexModule(v).unitsFor?.(v, 'buy', amount);
    // One bin, then two (one step between them).
    expect(units(100_000n)).toBe(70_000);
    expect(units(2_000_000n)).toBe(70_000 + 6_000 + 400);
    // Past the arrays read the pool cannot fill it: the default stands.
    expect(units(5_000_000n)).toBe(dexModule(v).units);
  });

  const budget = (ixs: Instruction[]) => [
    setComputeUnitLimit(300_000),
    setComputeUnitPrice(1_000n),
    ...ixs,
  ];
  const check = (v: DexVenue, side: Side, ixs: Instruction[]) =>
    validateTrade(budget(ixs), {
      wallet: WALLET,
      mint: MINT,
      route: v,
      side,
      maxSpend: 10n ** 12n,
      maxPriorityLamports: 10_000_000n,
    }).actions.filter((a) => !a.ok);

  it('passes the trades it builds, each with the bin arrays of its own direction', () => {
    const v = venue();
    const build = tradeBuilder(v);
    if (!build) throw new Error('no builder');
    const buy = build('buy', WALLET, 1_000_000n, 1n).instructions;
    const sell = build('sell', WALLET, 1_000_000n, 1n).instructions;
    expect(check(v, 'buy', buy)).toEqual([]);
    expect(check(v, 'sell', sell)).toEqual([]);
    const arrays = (ixs: Instruction[]) =>
      ixs
        .find((ix) => ix.programId === METEORA_DLMM_PROGRAM)
        ?.keys.slice(16)
        .map((k) => k.pubkey);
    const binArray = (index: number) =>
      findProgramAddress(
        [seed('bin_array'), POOL, new Uint8Array(new BigInt64Array([BigInt(index)]).buffer)],
        METEORA_DLMM_PROGRAM,
      );
    expect(arrays(buy)).toEqual([binArray(0)]);
    expect(arrays(sell)).toEqual([binArray(-1)]);
  });

  it('blocks a swap whose bin arrays are not the ones its direction walks', () => {
    const v = venue();
    const build = tradeBuilder(v);
    if (!build) throw new Error('no builder');
    const buy = build('buy', WALLET, 1_000_000n, 1n).instructions;
    const sold = check(v, 'sell', buy).map((a) => a.reason);
    expect(sold.length).toBeGreaterThan(0);
  });
});

describe('Meteora DBC pool addresses', () => {
  // Pools read from mainnet on 2026-11-03: each is its config's for its coin and SOL.
  it('derives a pool from its config, its coin and its quote token', () => {
    const pools = [
      [
        '8Ht5WdWUtGLAHUgktmxWk1LakeBRRSvcm7CvMzX4HaLZ',
        'Kf6tCmHjP9sDqmzUUCVv73R9qVrh5QkTzk656xrBAGS',
        'E99GUnyEopz8MpjLgQmifg2Lib4tjncw6b6tpjhiZJak',
      ],
      [
        '6m7XSKNZtiMz3yXfAk8QK5dejQb4aMHjc4bQrqi8h4VD',
        '2WCRNzC8Z5q78RqrdRapvWMJWBVAuSSPJdxmDrgyYiku',
        '771Pzfr5rY5pNUdurYC7oWL6FuH5vGJKLRWN4kp2qBcM',
      ],
    ] as const;
    for (const [config, coin, pool] of pools)
      expect(dbcPoolAddress(config, coin, WSOL_MINT)).toBe(pool);
  });
});
