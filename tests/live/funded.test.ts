import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/background/settings';
import { associatedTokenAddress } from '../../src/background/solana/address';
import { dexModule, type DexVenue } from '../../src/background/solana/dex';
import { isSolQuote, type Side } from '../../src/background/solana/pump';
import {
  bestRoute,
  routePay,
  routeToken,
  tradeBuilder,
  tradeUnits,
  validateTrade,
  type SolRoute,
} from '../../src/background/solana/routes';
import { SolanaService } from '../../src/background/solana/service';
import { createAtaIdempotent } from '../../src/background/solana/spl';
import type { Instruction } from '../../src/background/solana/tx';
import type { KeyValueStore } from '../../src/background/vault/vault';
import { budget, held, rpc, simulate, trades } from './solana-sim';

/**
 * A coin quoted in a token, bought and sold with SOL in two transactions, on Solana mainnet
 * by simulation only (no keys, nothing sent): SOL to the token on one of the token's SOL
 * pools, then the token to the coin; and back. The case is a pump.fun coin paired with
 * Apple's xStock, a Token-2022 mint whose transfer hook runs no program.
 */
const COIN = 'CDKbv7orjdM8aZuYLWqcNR7ZsttRhaSxgagYw7t6pump';

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

const service = new SolanaService({
  vault: { listAccounts: async () => [] } as never,
  settings: new SettingsStore(new MemoryStore()),
  local: new MemoryStore(),
  history: { list: async () => [] },
  notify: () => undefined,
  fetchJson: async (url: string) => (await fetch(url)).json(),
  now: Date.now,
});

/** Every trade checked, listed when the run ends. */
const checked: string[] = [];

/** A wallet among the recent traders on `address` that `ok` accepts, or null. */
async function traderOn(address: string, ok: (w: string) => Promise<boolean>) {
  const seen = new Set<string>();
  for await (const t of trades(address, 60)) {
    if (seen.has(t.signer)) continue;
    seen.add(t.signer);
    if (await ok(t.signer)) return t.signer;
  }
  return null;
}

const passes = (ixs: Instruction[], route: SolRoute, wallet: string, side: Side) =>
  expect(
    validateTrade(budget(ixs), {
      wallet,
      mint: routeToken(route).mint,
      route,
      side,
      maxSpend: 10n ** 30n,
      maxPriorityLamports: 10_000_000n,
    }).actions.filter((a) => !a.ok),
  ).toEqual([]);

/**
 * Simulates `ixs` for `wallet`, and checks it delivered what `route` quotes to `dest`: within
 * 1% (the pool may trade between the read and the simulation; the first step allows 1%).
 */
async function delivers(
  route: SolRoute,
  side: Side,
  wallet: string,
  amount: bigint,
  ixs: Instruction[],
  dest: { mint: string; program: string },
) {
  const quoted = bestRoute([route], side, amount)?.out ?? 0n;
  expect(quoted, `${side} ${amount} quoted nothing`).toBeGreaterThan(0n);
  const pre = await held(wallet, dest.mint, dest.program);
  const account = associatedTokenAddress(wallet, dest.mint, dest.program);
  const sim = await simulate(wallet, budget(ixs), [account]);
  expect(sim.err, sim.logs).toBeNull();
  expect(sim.units).toBeLessThan(tradeUnits(route, side, amount));
  const got = (sim.after[0] ?? 0n) - pre;
  const off = Number(((got - quoted) * 10_000n) / quoted);
  checked.push(`${side} ${amount}: quoted ${quoted}, got ${got} (${off} bps, ${sim.units} units)`);
  expect(Math.abs(off), `got ${got} for a quote of ${quoted}`).toBeLessThanOrEqual(100);
}

let coin: SolRoute | null = null;
let legs: DexVenue[] = [];

describe('a coin quoted in a token, traded with SOL (Solana mainnet simulation, no funds)', () => {
  beforeAll(async () => {
    const m = await service.market(COIN, 0);
    coin = m.routes[0] ?? null;
    legs = m.funding ?? [];
  }, 120_000);

  afterAll(() => {
    if (checked.length > 0) console.log(checked.join('\n'));
  });

  it('finds SOL pools of the token the coin is quoted in', (t) => {
    if (!coin) return t.skip(`${COIN} no longer trades`);
    const pay = routePay(coin);
    expect(isSolQuote(pay)).toBe(false);
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.mint).toBe(pay.mint);
      expect(isSolQuote(leg.quote)).toBe(true);
    }
  });

  it('buys the token with SOL on each of them', async (t) => {
    if (legs.length === 0) return t.skip('no SOL pool of the token');
    let traded = 0;
    for (const leg of legs) {
      const wallet = await traderOn(
        leg.pool,
        async (w) => (await rpc.getBalance(w)) > 100_000_000n,
      );
      if (!wallet) continue;
      const amount = 20_000_000n;
      const ixs = tradeBuilder(leg)?.('buy', wallet, amount, 1n).instructions ?? [];
      passes(ixs, leg, wallet, 'buy');
      checked.push(`${leg.dex} ${leg.pool}:`);
      await delivers(leg, 'buy', wallet, amount, ixs, {
        mint: leg.mint,
        program: leg.tokenProgram,
      });
      traded++;
    }
    if (traded === 0) t.skip('no recent trader with SOL to spare');
  }, 600_000);

  it('buys the coin with the token, and sells it back into the token', async (t) => {
    const route = coin;
    if (!route) return t.skip(`${COIN} no longer trades`);
    const pay = routePay(route);
    const token = routeToken(route);
    const build = tradeBuilder(route);
    if (!build) throw new Error('no builder');
    let traded = 0;

    const buyer = await traderOn(
      COIN,
      async (w) =>
        (await held(w, pay.mint, pay.program)) >= 200_000n &&
        (await rpc.getBalance(w)) > 10_000_000n,
    );
    if (buyer) {
      const has = await held(buyer, pay.mint, pay.program);
      const amount = has / 2n < 1_000_000n ? has / 2n : 1_000_000n;
      const ixs = build('buy', buyer, amount, 1n).instructions;
      passes(ixs, route, buyer, 'buy');
      checked.push(`${COIN} with ${pay.mint}:`);
      await delivers(route, 'buy', buyer, amount, ixs, {
        mint: token.mint,
        program: token.tokenProgram,
      });
      traded++;
    }

    // A tenth of what they hold, worth more than dust.
    const tenth = async (w: string) => (await held(w, token.mint, token.tokenProgram)) / 10n;
    const seller = await traderOn(
      COIN,
      async (w) =>
        (bestRoute([route], 'sell', await tenth(w))?.out ?? 0n) >= 10_000n &&
        (await rpc.getBalance(w)) > 5_000_000n,
    );
    if (seller) {
      const amount = await tenth(seller);
      const ixs = build('sell', seller, amount, 1n).instructions;
      passes(ixs, route, seller, 'sell');
      checked.push(`${COIN} into ${pay.mint}:`);
      await delivers(route, 'sell', seller, amount, ixs, pay);
      traded++;
    }
    if (traded === 0) t.skip('no recent trader holds the token or the coin');
  }, 600_000);

  it('sells the token for SOL on each of its SOL pools', async (t) => {
    if (legs.length === 0) return t.skip('no SOL pool of the token');
    let traded = 0;
    for (const leg of legs) {
      const wallet = await traderOn(
        leg.pool,
        async (w) =>
          (await held(w, leg.mint, leg.tokenProgram)) >= 200_000n &&
          (await rpc.getBalance(w)) > 5_000_000n,
      );
      if (!wallet) continue;
      const has = await held(wallet, leg.mint, leg.tokenProgram);
      const amount = has / 2n < 1_000_000n ? has / 2n : 1_000_000n;
      // As built: the wrapped SOL it pays is unwrapped in the same transaction.
      const built = tradeBuilder(leg)?.('sell', wallet, amount, 1n).instructions ?? [];
      passes(built, leg, wallet, 'sell');
      const real = await simulate(wallet, budget(built));
      expect(real.err, real.logs).toBeNull();
      // Without the unwrap, what it paid stays in the wrapped SOL account to be read.
      checked.push(`${leg.dex} ${leg.pool}:`);
      const kept = [
        createAtaIdempotent(wallet, leg.quote.mint, leg.quote.program),
        dexModule(leg).swap(leg, 'sell', wallet, amount, 1n),
      ];
      await delivers(leg, 'sell', wallet, amount, kept, leg.quote);
      traded++;
    }
    if (traded === 0) t.skip('no recent trader holds the token');
  }, 600_000);
});
