import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/background/settings';
import {
  STABLE_MINTS,
  SYSVAR_CLOCK,
  WSOL_MINT,
  associatedTokenAddress,
} from '../../src/background/solana/address';
import {
  DEX_MODULES,
  batchedReader,
  indexedPools,
  isDexQuote,
  type DexKind,
  type DexLoadCtx,
  type DexModule,
  type DexVenue,
} from '../../src/background/solana/dex';
import {
  EXT,
  decodeClock,
  decodeMint,
  decodeTokenAccount,
} from '../../src/background/solana/layouts';
import { SOL_QUOTE, isSolQuote, type Side } from '../../src/background/solana/pump';
import { tradeBuilder, tradeUnits, validateTrade } from '../../src/background/solana/routes';
import { SolanaService } from '../../src/background/solana/service';
import { createAtaIdempotent } from '../../src/background/solana/spl';
import type { Instruction } from '../../src/background/solana/tx';
import type { KeyValueStore } from '../../src/background/vault/vault';
import { budget, held, rpc, simulate, trades, type SeenIx } from './solana-sim';

/**
 * The pool programs beyond pump.fun's, on Solana mainnet by simulation only (no keys,
 * nothing sent). Pools and wallets come from each program's own recent swaps. Every trade
 * must pass the validator and simulate cleanly, and every quote must be what the program
 * actually pays, to the unit.
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

const fetchJson = async (url: string) => (await fetch(url)).json();
const service = new SolanaService({
  vault: { listAccounts: async () => [] } as never,
  settings: new SettingsStore(new MemoryStore()),
  local: new MemoryStore(),
  history: { list: async () => [] },
  notify: () => undefined,
  fetchJson,
  now: Date.now,
});

/** The pool each program's swap instructions trade on, read from their accounts. */
const POOL_OF: Record<DexKind, (ix: SeenIx) => string | undefined> = {
  // SwapBaseIn / SwapBaseOut, with or without the order book accounts: the AMM comes second.
  'raydium-amm': (ix) => ([9, 11, 16, 17].includes(ix.data[0] ?? -1) ? ix.accounts[1] : undefined),
  // swap_base_input / swap_base_output: the pool comes fourth.
  'raydium-cpmm': (ix) =>
    startsWith(ix.data, [143, 190, 90, 218, 196, 30, 51, 222]) ||
    startsWith(ix.data, [55, 217, 98, 86, 163, 74, 180, 173])
      ? ix.accounts[3]
      : undefined,
  // buy / sell, exact in or out: the pool comes fifth.
  launchlab: (ix) =>
    [
      [250, 234, 13, 123, 213, 156, 19, 236],
      [24, 211, 116, 40, 105, 3, 153, 56],
      [149, 39, 222, 155, 211, 124, 152, 26],
      [95, 200, 71, 34, 8, 9, 11, 166],
    ].some((d) => startsWith(ix.data, d))
      ? ix.accounts[4]
      : undefined,
  // swap / swap2: the pool comes second on DAMM v2, third on the bonding curve.
  'meteora-damm': (ix) => (isMeteoraSwap(ix) ? ix.accounts[1] : undefined),
  'meteora-dbc': (ix) => (isMeteoraSwap(ix) ? ix.accounts[2] : undefined),
  // swap / swap2 on DLMM: the pair comes first.
  'meteora-dlmm': (ix) => (isMeteoraSwap(ix) ? ix.accounts[0] : undefined),
  // swap: the whirlpool comes third; swap_v2 (token programs, memo, signer first): fifth.
  orca: (ix) =>
    startsWith(ix.data, [248, 198, 158, 145, 225, 117, 135, 200])
      ? ix.accounts[2]
      : startsWith(ix.data, [43, 4, 237, 11, 26, 201, 30, 98])
        ? ix.accounts[4]
        : undefined,
};

const isMeteoraSwap = (ix: SeenIx) =>
  startsWith(ix.data, [248, 198, 158, 145, 225, 117, 135, 200]) ||
  startsWith(ix.data, [65, 75, 63, 76, 235, 91, 91, 136]);

const startsWith = (d: Uint8Array, disc: readonly number[]) =>
  d.length >= disc.length && disc.every((b, i) => d[i] === b);

interface Found {
  pool: string;
  mint: string;
  /** A wallet that just swapped on the pool. */
  trader: string;
}

/** Token-2022 extensions Nesty refuses to trade through. */
const UNTRADABLE: readonly number[] = [EXT.transferFeeConfig, EXT.transferHook];

/** Pools of `m` swapped on lately, against wrapped SOL or a stablecoin, that it loads. */
async function scan(m: DexModule<DexVenue>, max: number, want: number): Promise<Found[]> {
  const out: Found[] = [];
  const seen = new Set<string>();
  for await (const t of trades(m.program, max)) {
    for (const ix of t.ixs) {
      const pool = ix.program === m.program ? POOL_OF[m.dex](ix) : undefined;
      if (!pool || seen.has(pool)) continue;
      seen.add(pool);
      const acc = await rpc.getAccount(pool);
      const mint = acc?.owner === m.program ? m.coinOf(acc.data) : null;
      if (!mint || isDexQuote(mint)) continue;
      const mintAcc = await rpc.getAccount(mint);
      const ext = mintAcc ? decodeMint(mintAcc.data)?.extensions : undefined;
      if (!ext || ext.some((e) => UNTRADABLE.includes(e))) continue;
      if (!(await m.load(await ctxFor(mint), pool, mint))) continue;
      out.push({ pool, mint, trader: t.signer });
    }
    if (out.length >= want) break;
  }
  return out;
}

async function ctxFor(mint: string): Promise<DexLoadCtx> {
  const owner = (await rpc.getAccount(mint))?.owner ?? '';
  return {
    read: batchedReader(rpc),
    coinProgram: owner,
    quoteAsset: async (q) => {
      if (q === WSOL_MINT) return SOL_QUOTE;
      if (!STABLE_MINTS.has(q)) return null;
      const program = (await rpc.getAccount(q))?.owner;
      return program ? { mint: q, program } : null;
    },
  };
}

/** A pool's state, less the clock it was read at (a quote moving with it is compared). */
const stateOf = (v: DexVenue) =>
  JSON.stringify(v, (k, x: unknown) =>
    k === 'clock' ? undefined : typeof x === 'bigint' ? x.toString() : x,
  );

async function amountAt(account: string): Promise<bigint> {
  const acc = await rpc.getAccount(account);
  return (acc && decodeTokenAccount(acc.data)?.amount) ?? 0n;
}

/**
 * Simulates one trade on `f`'s pool and checks that the program paid exactly the quote.
 * Busy pools trade between the reads and the simulation, so it tries again until the pool
 * (and the wallet) held still around it; null when it never did.
 */
async function checkExact(
  m: DexModule<DexVenue>,
  f: Found,
  side: Side,
  amount: bigint,
  build: (v: DexVenue) => { ixs: Instruction[]; dest: string },
) {
  const ctx = await ctxFor(f.mint);
  for (let attempt = 0; attempt < 8; attempt++) {
    const v = await m.load(ctx, f.pool, f.mint);
    if (!v) throw new Error(`${f.pool} no longer loads`);
    const { ixs, dest } = build(v);
    const pre = await amountAt(dest);
    expect(m.quote(v, side, amount), `${side} ${amount} on ${f.pool}`).toBeGreaterThan(0n);
    const sim = await simulate(f.trader, budget(ixs), [dest, SYSVAR_CLOCK]);
    const [again, preAgain] = await Promise.all([m.load(ctx, f.pool, f.mint), amountAt(dest)]);
    if (!again || stateOf(again) !== stateOf(v) || preAgain !== pre) continue;
    // A fee that moves with time is quoted at the clock the simulation ran at.
    const clock = sim.raw[1] ? decodeClock(sim.raw[1]) : null;
    const quoted = m.quote('clock' in v && clock ? { ...v, clock } : v, side, amount);
    expect(sim.err, sim.logs).toBeNull();
    expect((sim.after[0] ?? 0n) - pre).toBe(quoted);
    checked.push(
      `${m.dex} ${side} on ${f.pool}: ${amount} → ${quoted} (${sim.units} units of ${tradeUnits(v, side, amount)} asked)`,
    );
    return { sim, venue: v };
  }
  checked.push(`${m.dex} ${side} on ${f.pool}: skipped, it traded through every attempt`);
  return null;
}

/** A trade quoted 0 (a curve's last few units, say) must fail on chain as well. */
async function checkRefused(
  m: DexModule<DexVenue>,
  f: Found,
  side: Side,
  amount: bigint,
  build: (v: DexVenue) => Instruction[],
) {
  const ctx = await ctxFor(f.mint);
  const v = await m.load(ctx, f.pool, f.mint);
  if (!v || m.quote(v, side, amount) > 0n) return;
  const sim = await simulate(f.trader, budget(build(v)));
  const again = await m.load(ctx, f.pool, f.mint);
  if (!again || stateOf(again) !== stateOf(v)) return;
  expect(sim.err, `${side} ${amount} on ${f.pool} filled, though quoted 0`).not.toBeNull();
  checked.push(`${m.dex} ${side} on ${f.pool}: ${amount} cannot fill, and the program refuses it`);
}

/** A test buy for `f`'s trader: a little SOL, or one unit of the stablecoin; 0 without funds. */
async function buyAmount(f: Found, v: DexVenue): Promise<bigint> {
  if (isSolQuote(v.quote)) return (await rpc.getBalance(f.trader)) > 30_000_000n ? 5_000_000n : 0n;
  if ((await rpc.getBalance(f.trader)) < 10_000_000n) return 0n;
  const has = await held(f.trader, v.quote.mint, v.quote.program);
  return has / 2n < 1_000_000n ? has / 2n : 1_000_000n;
}

const passes = (ixs: Instruction[], v: DexVenue, f: Found, side: Side) =>
  expect(
    validateTrade(budget(ixs), {
      wallet: f.trader,
      mint: f.mint,
      route: v,
      side,
      maxSpend: 10n ** 30n,
      maxPriorityLamports: 10_000_000n,
    }).actions.filter((a) => !a.ok),
  ).toEqual([]);

/** Buys and sells on `f`'s pool with its trader's wallet, each quote checked to the unit. */
async function roundTrip(m: DexModule<DexVenue>, f: Found): Promise<'bought' | 'sold' | null> {
  const v = await m.load(await ctxFor(f.mint), f.pool, f.mint);
  if (!v || m.idle(v, Date.now() / 1000)) return null;
  const build = tradeBuilder(v);
  if (!build) throw new Error('no builder');
  const coinAta = associatedTokenAddress(f.trader, v.mint, v.tokenProgram);
  const quoteAta = associatedTokenAddress(f.trader, v.quote.mint, v.quote.program);
  let did: 'bought' | 'sold' | null = null;

  const amount = await buyAmount(f, v);
  const buy = (x: DexVenue) => tradeBuilder(x)?.('buy', f.trader, amount, 1n).instructions ?? [];
  if (amount > 0n && m.quote(v, 'buy', amount) === 0n) {
    await checkRefused(m, f, 'buy', amount, buy);
  } else if (amount > 0n) {
    passes(build('buy', f.trader, amount, 1n).instructions, v, f, 'buy');
    // As built for the wallet: wrap, open, swap, unwrap.
    const done = await checkExact(m, f, 'buy', amount, (x) => ({ ixs: buy(x), dest: coinAta }));
    if (done) {
      expect(done.sim.units).toBeLessThan(tradeUnits(done.venue, 'buy', amount));
      did = 'bought';
    }
  }

  const holding = await held(f.trader, v.mint, v.tokenProgram);
  const tokens = holding / 10n || holding;
  // Read again: the pool has likely traded since.
  const now = holding > 0n ? await m.load(await ctxFor(f.mint), f.pool, f.mint) : null;
  if (!now) return did;
  // Without the unwrap, what the sale paid stays in the quote account to be read.
  const sell = (x: DexVenue) => [
    createAtaIdempotent(f.trader, x.quote.mint, x.quote.program),
    m.swap(x, 'sell', f.trader, tokens, 1n),
  ];
  const pays = m.quote(now, 'sell', tokens);
  if (pays === 0n) {
    await checkRefused(m, f, 'sell', tokens, sell);
  } else if (pays < 1_000n) {
    // Dust: a tick of the price takes it to nothing.
    checked.push(`${m.dex} sell on ${f.pool}: skipped, ${tokens} pays only ${pays}`);
  } else {
    const built = tradeBuilder(now)?.('sell', f.trader, tokens, 1n).instructions ?? [];
    passes(built, now, f, 'sell');
    const real = await simulate(f.trader, budget(built));
    expect(real.err, real.logs).toBeNull();
    expect(real.units).toBeLessThan(tradeUnits(now, 'sell', tokens));
    if (await checkExact(m, f, 'sell', tokens, (x) => ({ ixs: sell(x), dest: quoteAta })))
      did ??= 'sold';
  }
  return did;
}

const found = new Map<DexKind, Found[]>();
/** Every trade checked to the unit, listed when the run ends. */
const checked: string[] = [];

describe('pools beyond pump.fun (Solana mainnet simulation, no funds)', () => {
  beforeAll(async () => {
    for (const m of DEX_MODULES) found.set(m.dex, await scan(m, 250, 6));
  }, 900_000);

  afterAll(() => {
    if (checked.length > 0) console.log(checked.join('\n'));
  });

  for (const m of DEX_MODULES) {
    it(`quotes ${m.dex} exactly, and trades on it within the compute it asks for`, async (t) => {
      const list = found.get(m.dex) ?? [];
      if (list.length === 0) return t.skip(`no ${m.dex} pool among recent swaps`);
      let traded = 0;
      for (const f of list) {
        if (await roundTrip(m, f)) traded++;
        if (traded >= 2) break;
      }
      if (traded === 0) t.skip(`every recent ${m.dex} trader is out of funds and coins`);
    }, 600_000);

    it(`finds the coin of a ${m.dex} pool a page points at`, async (t) => {
      const f = found.get(m.dex)?.[0];
      if (!f) return t.skip(`no ${m.dex} pool among recent swaps`);
      expect(await service.resolve(f.pool, 'pair')).toMatchObject({ mint: f.mint, source: 'pair' });
      // Named by a page, the pool is quoted for its coin from then on, unless pump.fun trades
      // it or the coin's most liquid pool is priced in another currency.
      const v = await m.load(await ctxFor(f.mint), f.pool, f.mint);
      const { routes, idle } = await service.market(f.mint, 0);
      // A bonding curve that filled since the scan says so until its new pool trades.
      const closed = v ? m.idle(v, Date.now() / 1000) : null;
      if (closed && routes.length === 0) return expect(idle).toBe(closed);
      expect(routes.length, `routes for ${f.mint} via ${f.pool}`).toBeGreaterThan(0);
      const first = routes[0];
      if (v && !closed && first?.kind === 'dex' && first.quote.mint === v.quote.mint)
        expect(routes.some((r) => r.kind === 'dex' && r.pool === f.pool)).toBe(true);
    }, 120_000);
  }

  it('trades a pump.fun coin that migrated to Raydium before PumpSwap existed', async (t) => {
    const old = (found.get('raydium-amm') ?? []).filter((f) => f.mint.endsWith('pump'));
    for (const f of old) {
      const { route } = await service.route(f.mint, 0);
      if (route) continue;
      const listed = await indexedPools(fetchJson, f.mint, 3).catch(() => null);
      if (!listed) return t.skip('the pool index did not answer');
      const { routes, idle } = await service.market(f.mint, 0);
      const seen = `${f.mint} (indexed: ${listed.map((p) => p.pool).join(', ') || 'none'})`;
      expect(idle, seen).toBeNull();
      expect(routes[0]?.kind, seen).toBe('dex');
      if (listed.some((p) => p.pool === f.pool))
        expect(routes.some((r) => r.kind === 'dex' && r.pool === f.pool)).toBe(true);
      return;
    }
    t.skip('no migrated pump.fun coin among recent Raydium swaps');
  }, 120_000);
});
