import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/background/settings';
import { SYSTEM_PROGRAM, findProgramAddress, seed } from '../../src/background/solana/address';
import { DEX_MODULES } from '../../src/background/solana/dex';
import { PUMP_PROGRAM, isSolQuote } from '../../src/background/solana/pump';
import {
  buyQuote,
  pumpRoute,
  tradeBuilder,
  type SolRoute,
} from '../../src/background/solana/routes';
import { SolanaService } from '../../src/background/solana/service';
import {
  setComputeUnitLimit,
  setComputeUnitPrice,
  transfer,
} from '../../src/background/solana/spl';
import type { Instruction } from '../../src/background/solana/tx';
import type { KeyValueStore } from '../../src/background/vault/vault';
import type { SolTradeIntent } from '../../src/shared/site-bridge';
import { rpc, trades } from './solana-sim';

/**
 * What the extension checks before it signs a trade the Nesty website built, against
 * mainnet pools (reads only; nothing is signed or sent). The site's own build must pass;
 * a missing minimum, a slipped-in transfer, or another trade than the one named must not.
 */
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

// Addresses made up for the test: nobody's wallet.
const WALLET = findProgramAddress([seed('nesty-site-test-wallet')], SYSTEM_PROGRAM);
const STRANGER = findProgramAddress([seed('nesty-site-test-stranger')], SYSTEM_PROGRAM);
const AMOUNT = 2_000_000n;

const budget = (ixs: Instruction[]) => [
  setComputeUnitLimit(200_000),
  setComputeUnitPrice(1_000n),
  ...ixs,
];

/** A coin of `program`'s recent trades that trades now, with the route and intent for it. */
async function findRoute(
  program: string,
  pick: (accounts: string[]) => string | undefined,
  load: (mint: string, at: string) => Promise<{ route: SolRoute; intent: SolTradeIntent } | null>,
) {
  const seen = new Set<string>();
  for await (const t of trades(program, 60)) {
    for (const ix of t.ixs) {
      const at = ix.program === program ? pick(ix.accounts) : undefined;
      if (!at || seen.has(at)) continue;
      seen.add(at);
      const acc = await rpc.getAccount(at);
      const mod = DEX_MODULES.find((m) => m.program === acc?.owner);
      const mint = mod && acc ? mod.coinOf(acc.data) : program === PUMP_PROGRAM ? at : null;
      if (!mint) continue;
      const found = await load(mint, at).catch(() => null);
      if (
        found &&
        isSolQuote(found.route.kind === 'pump' ? found.route.pump.pay : found.route.quote)
      )
        return found;
    }
  }
  return null;
}

async function checks(route: SolRoute, intent: SolTradeIntent) {
  const build = tradeBuilder(route);
  if (!build) throw new Error('no builder');
  const minOut = (buyQuote(route, AMOUNT) * 9n) / 10n;
  const built = budget(build('buy', WALLET, AMOUNT, minOut).instructions);
  const check = (ixs: Instruction[], i: SolTradeIntent = intent) =>
    service.checkSiteTrade(WALLET, ixs, i);

  expect(await check(built)).toMatchObject({ ok: true });
  // No real minimum received: refused, whatever the site's slippage setting.
  const greedy = budget(build('buy', WALLET, AMOUNT, 1n).instructions);
  expect(await check(greedy)).toMatchObject({ ok: false });
  // Anything besides the trade: refused.
  expect(await check([...built, transfer(WALLET, STRANGER, 1n)])).toMatchObject({ ok: false });
  // Signed as a sell, or for another coin: refused.
  expect(await check(built, { ...intent, side: 'sell' })).toMatchObject({ ok: false });
  expect(await check(built, { ...intent, mint: STRANGER })).toMatchObject({ ok: false });
}

describe('trades the Nesty website asks the extension to sign (mainnet reads)', () => {
  it('passes a pool trade as built, and nothing changed from it', async (t) => {
    const m = DEX_MODULES.find((x) => x.dex === 'raydium-cpmm');
    if (!m) throw new Error('no module');
    const found = await findRoute(
      m.program,
      (a) => a[3],
      async (mint, pool) => {
        const v = await service.venueAt(mint, pool);
        return v
          ? { route: v, intent: { kind: 'trade', mint, side: 'buy', route: { kind: 'dex', pool } } }
          : null;
      },
    );
    if (!found) return t.skip('no open pool among recent swaps');
    await checks(found.route, found.intent);
    // A pool the intent does not name.
    const other = { ...found.intent, route: { kind: 'dex' as const, pool: STRANGER } };
    const build = tradeBuilder(found.route);
    const built = budget(build?.('buy', WALLET, AMOUNT, 1_000n).instructions ?? []);
    expect(await service.checkSiteTrade(WALLET, built, other)).toMatchObject({ ok: false });
  }, 120_000);

  it('passes a pump.fun trade as built, and nothing changed from it', async (t) => {
    const found = await findRoute(
      PUMP_PROGRAM,
      (a) => a[2],
      async (mint) => {
        const { route, idle } = await service.route(mint, 0);
        return route && !idle
          ? {
              route: pumpRoute(route),
              intent: { kind: 'trade', mint, side: 'buy', route: { kind: 'pump' } },
            }
          : null;
      },
    );
    if (!found) return t.skip('no open pump.fun coin among recent trades');
    await checks(found.route, found.intent);
  }, 120_000);
});
