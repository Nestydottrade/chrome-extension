import { describe, expect, it, vi } from 'vitest';
import { EXIT_CHECK_MS, ExitWatcher } from '../src/background/exits';
import { publicKeyOf } from '../src/background/solana/keys';
import {
  ExitRuleInputSchema,
  coveredCost,
  dueRule,
  mergeRules,
  multipleBps,
  ruleText,
  type ExitRule,
} from '../src/shared/exits';
import { RequestSchema } from '../src/shared/messages';
import type { TradeTicket } from '../src/shared/panel';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const tp = (id: string, x: number, sell: number): ExitRule => ({
  id,
  kind: 'tp',
  triggerBps: x,
  sellBps: sell,
});

describe('exit plan rules', () => {
  it('refuses a take profit at or below 1x and a stop of 100%', () => {
    expect(ExitRuleInputSchema.safeParse(tp('a', 10_000, 5_000)).success).toBe(false);
    expect(
      ExitRuleInputSchema.safeParse({ id: 'b', kind: 'sl', triggerBps: 10_000, sellBps: 1 })
        .success,
    ).toBe(false);
    expect(ExitRuleInputSchema.safeParse(tp('c', 20_000, 5_000)).success).toBe(true);
  });

  it('values only the part of the holding with a cost', () => {
    const basis = new Map([
      ['w1', { tokens: 100n, costWei: 1_000n }],
      ['w2', { tokens: 50n, costWei: 500n }],
    ]);
    // w1 holds more than it bought (a transfer in), w2 sold half, w3 has no cost at all.
    const r = coveredCost(
      [
        { walletId: 'w1', token: 150n },
        { walletId: 'w2', token: 25n },
        { walletId: 'w3', token: 40n },
      ],
      basis,
    );
    expect(r).toEqual({ covered: 125n, costWei: 1_250n });
  });

  it('measures the price as a multiple of the average cost', () => {
    // 200 held return 4_000 wei; 100 of them cost 1_000 wei: 2x.
    expect(multipleBps(4_000n, 200n, 100n, 1_000n)).toBe(20_000);
    expect(multipleBps(1n, 0n, 100n, 1_000n)).toBe(0);
  });

  it('fires one step per check, stops before take profits', () => {
    const rules: ExitRule[] = [
      tp('a', 20_000, 5_000),
      tp('b', 30_000, 10_000),
      { id: 's', kind: 'sl', triggerBps: 4_000, sellBps: 10_000 },
    ];
    expect(dueRule({ rules }, 15_000).rule).toBeNull();
    expect(dueRule({ rules }, 35_000).rule?.id).toBe('b');
    expect(dueRule({ rules: [{ ...rules[1]!, done: true }, rules[0]!] }, 35_000).rule?.id).toBe(
      'a',
    );
    expect(dueRule({ rules }, 6_000).rule?.id).toBe('s');
  });

  it('trails from the highest price seen', () => {
    const rules: ExitRule[] = [{ id: 't', kind: 'trail', triggerBps: 2_500, sellBps: 10_000 }];
    const up = dueRule({ rules }, 40_000);
    expect(up).toEqual({ rule: null, peakBps: 40_000 });
    expect(dueRule({ rules, peakBps: up.peakBps }, 31_000).rule).toBeNull();
    expect(dueRule({ rules, peakBps: up.peakBps }, 30_000).rule?.id).toBe('t');
  });

  it('keeps fired steps fired when the plan is saved again', () => {
    const prev: ExitRule[] = [{ ...tp('a', 20_000, 5_000), done: true, firedAt: 1 }];
    const kept = mergeRules(prev, [tp('a', 20_000, 5_000), tp('b', 30_000, 5_000)]);
    expect(kept[0]).toMatchObject({ done: true, firedAt: 1 });
    expect(kept[1]?.done).toBeUndefined();
    // Changing a step re-arms it.
    expect(mergeRules(prev, [tp('a', 25_000, 5_000)])[0]?.done).toBeUndefined();
  });

  it('labels steps', () => {
    expect(ruleText(tp('a', 25_000, 5_000))).toBe('2.5x · sell 50%');
    expect(ruleText({ id: 's', kind: 'sl', triggerBps: 4_000, sellBps: 10_000 })).toBe(
      '−40% · sell all',
    );
    expect(ruleText({ id: 't', kind: 'trail', triggerBps: 2_500, sellBps: 10_000 })).toBe(
      '−25% from peak · sell all',
    );
  });
});

describe('exit plans on Solana', () => {
  // A made-up mint: base58, so its case matters.
  const MINT = publicKeyOf(new Uint8Array(32).fill(9));
  const LAMPORTS = 1_000_000_000n;
  const bought: TradeTicket = {
    id: 't1',
    kind: 'buy',
    chainId: SOLANA_CHAIN_ID,
    mint: MINT,
    status: 'done',
    createdAt: 1,
    explorer: 'https://solscan.io',
    // 1 SOL for 1,000,000 units of the coin.
    legs: [
      {
        walletId: 'a',
        walletName: 'A',
        kind: 'swap',
        status: 'confirmed',
        amountIn: LAMPORTS.toString(),
        amountOut: '1000000',
      },
    ],
  };

  function watcher() {
    const store = new Map<string, unknown>();
    // What selling the whole holding returns now, in lamports; or why it cannot be sold.
    let value: { out: bigint; unit: string | null } | { why: string } = {
      out: LAMPORTS,
      unit: null,
    };
    const sells: unknown[] = [];
    const w = new ExitWatcher({
      local: {
        get: async (k) => structuredClone(store.get(k)),
        set: async (k, v) => void store.set(k, structuredClone(v)),
      },
      history: { list: async () => [bought] } as never,
      vault: { isUnlocked: async () => true } as never,
      solana: {
        holdingsOf: async (mint, walletIds) => ({
          held:
            walletIds.includes('a') && mint === MINT ? [{ walletId: 'a', token: 1_000_000n }] : [],
          symbol: 'COIN',
        }),
        sellValue: async () => value,
        sell: async (req) => void sells.push(req),
      },
      // EVM only: never reached by a Solana plan.
      routing: {} as never,
      engine: {} as never,
      settings: {} as never,
      client: {} as never,
      fetchJson: {} as never,
      aggregator: {} as never,
      now: () => 5,
    });
    return {
      w,
      sells,
      worth: (v: typeof value) => {
        value = v;
      },
    };
  }

  it('measures a coin by its mint and sells through the Solana service when a step is hit', async () => {
    vi.useFakeTimers();
    try {
      const { w, sells, worth } = watcher();
      const plan = await w.set({
        chainId: SOLANA_CHAIN_ID,
        token: MINT,
        walletIds: ['a', 'b'],
        rules: [
          tp('x2', 20_000, 5_000),
          { id: 'sl', kind: 'sl', triggerBps: 4_000, sellBps: 10_000 },
        ],
      });
      // Kept exactly as given, and only the wallet that holds it is watched.
      expect(plan).toMatchObject({ token: MINT, symbol: 'COIN', walletIds: ['a'] });
      expect(await w.get(SOLANA_CHAIN_ID, MINT.toLowerCase())).toBeNull();

      worth({ out: (LAMPORTS * 3n) / 2n, unit: null });
      // The next check: the watcher runs one about every second.
      await vi.advanceTimersByTimeAsync(EXIT_CHECK_MS);
      expect((await w.get(SOLANA_CHAIN_ID, MINT))?.nowBps).toBe(15_000);
      expect(sells).toEqual([]);

      worth({ out: (LAMPORTS * 5n) / 2n, unit: null });
      // The next check: the watcher runs one about every second.
      await vi.advanceTimersByTimeAsync(EXIT_CHECK_MS);
      expect(sells).toEqual([{ mint: MINT, bps: 5_000, walletIds: ['a'], confirmed: true }]);
      const fired = (await w.get(SOLANA_CHAIN_ID, MINT))?.rules.find((r) => r.id === 'x2');
      expect(fired).toMatchObject({ done: true, firedAt: 5 });

      worth({ why: 'Bonding curve complete: moving to PumpSwap.' });
      // The next check: the watcher runs one about every second.
      await vi.advanceTimersByTimeAsync(EXIT_CHECK_MS);
      expect((await w.get(SOLANA_CHAIN_ID, MINT))?.paused).toBe(
        'Bonding curve complete: moving to PumpSwap.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures only costs paid in what the coin is valued in now', async () => {
    vi.useFakeTimers();
    try {
      const { w, sells, worth } = watcher();
      await w.set({
        chainId: SOLANA_CHAIN_ID,
        token: MINT,
        walletIds: ['a'],
        rules: [tp('x2', 20_000, 5_000)],
      });
      // Valued in a token now, while it was bought with SOL: nothing to measure it against.
      worth({ out: 10n ** 12n, unit: publicKeyOf(new Uint8Array(32).fill(8)) });
      await vi.advanceTimersByTimeAsync(EXIT_CHECK_MS);
      expect((await w.get(SOLANA_CHAIN_ID, MINT))?.paused).toBe(
        'No cost on record for what is held.',
      );
      expect(sells).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses wallets that hold none of it', async () => {
    const { w } = watcher();
    await expect(
      w.set({
        chainId: SOLANA_CHAIN_ID,
        token: MINT,
        walletIds: ['b'],
        rules: [tp('x2', 20_000, 5_000)],
      }),
    ).rejects.toThrow('Pick a wallet that holds this token.');
  });
});

describe('exit plan requests', () => {
  const MINT = publicKeyOf(new Uint8Array(32).fill(9));
  const EVM_TOKEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
  const parse = (chainId: number, token: string) =>
    RequestSchema.safeParse({ type: 'exits.get', chainId, token }).success;

  it('takes a mint on Solana and a 0x address on EVM chains, never the other way round', () => {
    expect(parse(SOLANA_CHAIN_ID, MINT)).toBe(true);
    expect(parse(8453, EVM_TOKEN)).toBe(true);
    expect(parse(SOLANA_CHAIN_ID, EVM_TOKEN)).toBe(false);
    expect(parse(8453, MINT)).toBe(false);
    expect(
      RequestSchema.safeParse({
        type: 'exits.set',
        chainId: SOLANA_CHAIN_ID,
        token: MINT,
        walletIds: ['a'],
        rules: [tp('x2', 20_000, 5_000)],
      }).success,
    ).toBe(true);
  });
});
