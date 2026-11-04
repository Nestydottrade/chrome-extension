import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import { IPFS_GATEWAY, LogoService, ipfsCid } from '../../src/background/logos';
import { SettingsStore } from '../../src/background/settings';
import {
  STABLE_MINTS,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
} from '../../src/background/solana/address';
import { Reader, decodeTokenAccount } from '../../src/background/solana/layouts';
import {
  BUYBACK_FEE_RECIPIENTS,
  IX,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  bondingCurveAddress,
  buyInstructions,
  canonicalPoolAddress,
  isSolQuote,
  pickRecipients,
  routeBuyQuote,
  routeCoin,
  routeSellQuote,
  routeVariant,
  sellInstructions,
  type PumpRoute,
  type PumpVenue,
  type Side,
} from '../../src/background/solana/pump';
import { SolRpc } from '../../src/background/solana/rpc';
import { SolanaService } from '../../src/background/solana/service';
import {
  createAtaIdempotent,
  setComputeUnitLimit,
  setComputeUnitPrice,
  transfer,
  transferChecked,
} from '../../src/background/solana/spl';
import { SOL_UNITS, TOKEN_UNITS, tokenAccountSize } from '../../src/background/solana/transfers';
import {
  MAX_TX_BYTES,
  compileMessage,
  serializeTransaction,
  type Instruction,
} from '../../src/background/solana/tx';
import {
  validateSolanaTransfer,
  validateSolanaTx,
  type SolTransferContext,
  type SolValidationContext,
} from '../../src/background/solana/validator';
import type { KeyValueStore } from '../../src/background/vault/vault';
import { toBase64 } from '../../src/shared/base64';
import { SOLANA } from '../../src/shared/solana';

/**
 * pump.fun on Solana mainnet, by simulation only (no keys, nothing sent): coins and wallets
 * are picked from the programs' own recent trades, so nothing third-party is hard-coded.
 * Each built transaction must pass the validator and simulate cleanly, and our quotes must
 * match what the programs actually pay, to the unit.
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

// Finding traders reads a lot of history: api.mainnet-beta answers that here (no Origin),
// though it refuses the extension. The service itself uses the built-in endpoint.
const rpc = new SolRpc(['https://api.mainnet-beta.solana.com', ...SOLANA.rpcUrls]);
const service = new SolanaService({
  // No wallets: the tests build and simulate their transactions themselves.
  vault: { listAccounts: async () => [] } as never,
  settings: new SettingsStore(new MemoryStore()),
  local: new MemoryStore(),
  history: { list: async () => [] },
  notify: () => undefined,
  fetchJson: async (url) => (await fetch(url)).json(),
  now: Date.now,
});

// ── finding coins of each kind ──────────────────────────────────────────────

/** The trade shapes Nesty builds, each tested on a live coin when one trades now. */
type Kind = 'curve-v3' | 'curve-v2' | 'pool-v2' | 'pool-v1' | 'multi-hop' | 'token-pay';

function kindsOf(r: PumpRoute): Kind[] {
  const variant = routeVariant(r);
  const sol = isSolQuote(r.pay);
  const kinds: Kind[] = [];
  if (variant === 'curve-v3' && sol) kinds.push('curve-v3');
  if (variant === 'pool-v2' && sol) kinds.push('pool-v2');
  if (variant === 'curve-v2' || variant === 'pool-v1' || variant === 'multi-hop')
    kinds.push(variant);
  if (!sol) kinds.push('token-pay');
  return kinds;
}

interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

interface RawTx {
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { instructions: RawIx[] }[] | null;
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
}

interface SeenIx {
  program: string;
  data: Uint8Array;
  accounts: string[];
}

/** The successful transactions that touched `address`, newest first: signer and instructions. */
async function* trades(address: string, max: number) {
  let before: string | undefined;
  let seen = 0;
  while (seen < max) {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [
      address,
      { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) },
    ]);
    if (sigs.length === 0) return;
    before = sigs[sigs.length - 1]?.signature;
    for (const s of sigs) {
      if (s.err) continue;
      if (seen++ >= max) return;
      const tx = await rpc
        .call<RawTx | null>('getTransaction', [
          s.signature,
          { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
        ])
        .catch(() => null);
      if (!tx?.meta || tx.meta.err) continue;
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const all = [
        ...tx.transaction.message.instructions,
        ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
      ];
      yield {
        signer: keys[0] ?? '',
        ixs: all.map((ix): SeenIx => ({
          program: keys[ix.programIdIndex] ?? '',
          data: base58.decode(ix.data),
          accounts: ix.accounts.map((a) => keys[a] ?? ''),
        })),
      };
    }
  }
}

const startsWith = (d: Uint8Array, disc: readonly number[]) =>
  d.length >= disc.length && disc.every((b, i) => d[i] === b);
/** `buy` / `sell` of the first versions: same names, same discriminators, in both programs. */
const V1_BUY = [102, 6, 61, 18, 1, 218, 235, 234];
const V1_SELL = IX.ammSell;

/** The coins a pump.fun or PumpSwap trade instruction names. */
function mintsOf(ix: SeenIx): string[] {
  const d = ix.data;
  const any = (...discs: (readonly number[])[]) => discs.some((x) => startsWith(d, x));
  let found: (string | undefined)[] = [];
  if (ix.program === PUMP_PROGRAM) {
    if (any(IX.buyExactQuoteInV3, IX.sellV3, IX.buyExactQuoteInV2, IX.sellV2))
      found = [ix.accounts[1]];
    else if (any(V1_BUY, V1_SELL)) found = [ix.accounts[2]];
  } else if (ix.program === PUMP_AMM_PROGRAM) {
    if (any(IX.multiHopSwap)) {
      for (let i = 16; i < ix.accounts.length; i += 5) found.push(ix.accounts[i]);
    } else if (any(V1_BUY, V1_SELL, IX.ammBuyExactQuoteIn, IX.buyExactQuoteInV2, IX.sellV2)) {
      found = [ix.accounts[3]];
    }
  }
  return found.filter((m): m is string => !!m && m !== WSOL_MINT && !STABLE_MINTS.has(m));
}

interface Found {
  mint: string;
  /** A wallet that traded it and still holds some. */
  trader: string;
}

/** A few coins per kind: a trader may sell out between the scan and the test. */
const catalog = new Map<Kind, Found[]>();
const SPARES = 3;
const found = (k: Kind) => catalog.get(k)?.length ?? 0;
const routes = new Map<string, PumpRoute | null>();

async function held(owner: string, v: { mint: string; program: string }): Promise<bigint> {
  const acc = await rpc.getAccount(associatedTokenAddress(owner, v.mint, v.program));
  return (acc && decodeTokenAccount(acc.data)?.amount) ?? 0n;
}

/** Reads recent trades through `address` until each of `kinds` has a coin and a holder. */
async function scan(address: string, max: number, kinds: readonly Kind[]): Promise<void> {
  for await (const t of trades(address, max)) {
    if (kinds.every((k) => found(k) >= SPARES)) return;
    for (const mint of new Set(t.ixs.flatMap(mintsOf))) {
      if (!routes.has(mint)) {
        const r = await service.route(mint, 0).catch(() => null);
        routes.set(mint, r?.route && routeCoin(r.route).mint === mint ? r.route : null);
      }
      const route = routes.get(mint);
      const open = route
        ? kindsOf(route).filter(
            (k) => found(k) < SPARES && !catalog.get(k)?.some((f) => f.mint === mint),
          )
        : [];
      if (!route || open.length === 0) continue;
      const coin = routeCoin(route);
      const amount = await held(t.signer, { mint, program: coin.tokenProgram }).catch(() => 0n);
      if (amount === 0n) continue;
      for (const k of open) catalog.set(k, [...(catalog.get(k) ?? []), { mint, trader: t.signer }]);
    }
  }
}

// ── simulating, and reading what the programs did ───────────────────────────

async function simulate(owner: string, ixs: Instruction[]) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const raw = serializeTransaction(compileMessage(owner, ixs, blockhash), []);
  const r = await rpc.call<{
    value: {
      err: unknown;
      logs: string[] | null;
      unitsConsumed?: number;
      innerInstructions?: { index: number; instructions: { data?: unknown }[] }[] | null;
      preBalances?: number[] | null;
    };
  }>('simulateTransaction', [
    toBase64(raw),
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      innerInstructions: true,
    },
  ]);
  return {
    err: r.value.err,
    logs: (r.value.logs ?? []).join('\n'),
    units: r.value.unitsConsumed ?? 0,
    bytes: raw.length,
    /** The fee payer's balance the simulation started from. */
    payerBalance: BigInt(r.value.preBalances?.[0] ?? -1),
    /** The inner instructions run under top-level instructions `from` up to `to`. */
    inner: (from = 0, to = ixs.length) =>
      (r.value.innerInstructions ?? [])
        .filter((g) => g.index >= from && g.index < to)
        .flatMap((g) =>
          // Known programs come back parsed, without raw data: only our events matter here.
          g.instructions.flatMap((ix) =>
            typeof ix.data === 'string' ? [base58.decode(ix.data)] : [],
          ),
        ),
  };
}

/** Anchor `emit_cpi!`: a self-call whose data is this tag, the event's discriminator, its fields. */
const EVENT_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const DISC = {
  trade: [189, 219, 127, 211, 78, 230, 97, 238],
  buy: [103, 244, 82, 31, 44, 245, 119, 119],
  sell: [62, 47, 55, 10, 165, 3, 220, 42],
};

/** Every event of one kind, in the order the programs emitted them. */
function eventsOf(inner: Uint8Array[], disc: number[]): Reader[] {
  return inner
    .filter(
      (x) =>
        x.length > 16 &&
        EVENT_TAG.every((b, i) => x[i] === b) &&
        disc.every((b, i) => x[8 + i] === b),
    )
    .map((x) => new Reader(x, 16));
}

/**
 * pump `TradeEvent`: the amounts, and the curve's reserves after the trade. A token-quoted
 * curve reports its quote side in the `quote_*` fields at the end, not the `sol_*` ones.
 */
function tradeEvent(r: Reader) {
  r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  r.pubkey();
  r.skip(8);
  const vsr = r.u64();
  const vtr = r.u64();
  const rsr = r.u64();
  const rtr = r.u64();
  r.pubkey();
  r.u64();
  const fee = r.u64();
  r.pubkey();
  r.u64();
  const creatorFee = r.u64();
  // Volume tracking, the instruction name, mayhem, cashback and buyback, then shareholders.
  r.bool();
  r.skip(8 * 4);
  r.string();
  r.bool();
  r.skip(8 * 4);
  r.skip(r.u32() * 34);
  r.pubkey();
  const quoteAmount = r.u64();
  const vqr = r.u64();
  const rqr = r.u64();
  const quoted = vqr > 0n;
  return {
    solAmount: quoted ? quoteAmount : solAmount,
    tokenAmount,
    isBuy,
    vsr: quoted ? vqr : vsr,
    vtr,
    rsr: quoted ? rqr : rsr,
    rtr,
    fee,
    creatorFee,
  };
}

/** PumpSwap `BuyEvent` / `SellEvent`: the amounts, and the pool before the trade. */
function poolEvent(r: Reader, side: Side) {
  r.skip(8);
  const baseAmount = r.u64();
  r.u64();
  r.skip(16);
  const poolBase = r.u64();
  const poolQuote = r.u64();
  r.skip(8 * 6);
  const userQuote = r.u64();
  r.skip(32 * 7 + 16);
  if (side === 'buy') {
    r.bool();
    r.skip(8 * 4);
    r.u64();
    r.string();
  }
  r.skip(8 * 4);
  const vqr = r.i128();
  return { baseAmount, poolBase, poolQuote, userQuote, vqr };
}

/**
 * The route as each hop stood before the trade, rebuilt from the hops' events, and what
 * the trade paid out at its end.
 */
function replay(r: PumpRoute, side: Side, inner: Uint8Array[]): { before: PumpRoute; out: bigint } {
  const curves = eventsOf(inner, DISC.trade).map(tradeEvent);
  const pools = eventsOf(inner, DISC[side]).map((e) => poolEvent(e, side));
  const order = side === 'buy' ? r.hops : [...r.hops].reverse();
  let out = 0n;
  const rebuilt = order.map((v): PumpVenue => {
    if (v.kind === 'curve') {
      const e = curves.shift();
      if (!e) throw new Error('no TradeEvent for a curve hop');
      expect(e.isBuy).toBe(side === 'buy');
      const s = side === 'buy' ? -1n : 1n;
      out = side === 'buy' ? e.tokenAmount : e.solAmount - e.fee - e.creatorFee;
      return {
        ...v,
        curve: {
          ...v.curve,
          // The event reports the curve after the trade: step back over the trade itself.
          virtualQuoteReserves: e.vsr + s * e.solAmount,
          virtualTokenReserves: e.vtr - s * e.tokenAmount,
          realQuoteReserves: e.rsr + s * e.solAmount,
          realTokenReserves: e.rtr - s * e.tokenAmount,
        },
      };
    }
    const e = pools.shift();
    if (!e) throw new Error(`no ${side} event for a pool hop`);
    out = side === 'buy' ? e.baseAmount : e.userQuote;
    // The event reports the vaults before the trade.
    return {
      ...v,
      baseReserve: e.poolBase,
      quoteReserve: e.poolQuote,
      pool: { ...v.pool, virtualQuoteReserves: e.vqr },
    };
  });
  return { before: { pay: r.pay, hops: side === 'buy' ? rebuilt : rebuilt.reverse() }, out };
}

const budget = (ixs: Instruction[]) => [
  setComputeUnitLimit(1_400_000),
  setComputeUnitPrice(1_000n),
  ...ixs,
];

/** What `owner` can spend on a test buy: a little SOL, or one unit of the pay token. */
async function buyAmount(owner: string, r: PumpRoute, payDecimals: number): Promise<bigint> {
  const sol = await rpc.getBalance(owner);
  if (isSolQuote(r.pay)) return sol > 30_000_000n ? 5_000_000n : 0n;
  if (sol < 10_000_000n) return 0n;
  const pay = await held(owner, r.pay);
  const unit = 10n ** BigInt(payDecimals);
  return pay / 2n < unit ? pay / 2n : unit;
}

/** Whether `f`'s trader can still buy (has the funds) or sell (still holds some). */
async function canTrade(f: Found): Promise<boolean> {
  const { route } = await service.route(f.mint, 0);
  if (!route) return false;
  const coin = routeCoin(route);
  const decimals = isSolQuote(route.pay)
    ? 9
    : ((await service.tokenMeta(route.pay.mint))?.decimals ?? 0);
  if ((await buyAmount(f.trader, route, decimals)) > 0n) return true;
  return (await held(f.trader, { mint: coin.mint, program: coin.tokenProgram })) > 0n;
}

/**
 * Compute used under each top-level instruction, from the runtime's log: "Program X invoke
 * [1]" opens one, and the "consumed" line printed at that depth closes it.
 */
function unitsPerInstruction(logs: string): number[] {
  const out: number[] = [];
  let depth = 0;
  for (const line of logs.split('\n')) {
    const invoke = /^Program \S+ invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      depth = Number(invoke[1]);
      if (depth === 1) out.push(0);
      continue;
    }
    const used = /^Program \S+ consumed (\d+) of \d+ compute units$/.exec(line);
    if (used && depth === 1) out[out.length - 1] = Number(used[1]);
    if (/^Program \S+ (success|failed)/.test(line)) depth = Math.max(0, depth - 1);
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
/** Any 32 bytes: only the size of a message is measured with it. */
const DEFAULT_BLOCKHASH = '11111111111111111111111111111111';

/**
 * Buys `f.mint` from its trader's wallet and sells part of it back, in one simulated
 * transaction (so nobody can sell the wallet out in between); every quote checked exactly
 * against the state the programs traded on. Without the funds to buy, it sells what the
 * wallet holds instead.
 */
async function roundTrip(f: Found) {
  const owner = f.trader;
  // Read right before trading: busy coins move within seconds.
  const { route } = await service.route(f.mint, 0);
  if (!route) throw new Error(`${f.mint} no longer trades`);
  const rec = pickRecipients(route);
  if (!rec) throw new Error('no fee recipients');
  const coin = routeCoin(route);
  const payMeta = isSolQuote(route.pay)
    ? { symbol: 'SOL', decimals: 9 }
    : await service.tokenMeta(route.pay.mint);
  if (!payMeta) throw new Error('pay token unreadable');
  const ctx = (side: Side): SolValidationContext => ({
    wallet: owner,
    mint: f.mint,
    route,
    side,
    maxSpend: 10n ** 30n,
    maxPriorityLamports: 10_000_000n,
    payUnit: { symbol: payMeta.symbol, decimals: payMeta.decimals },
  });
  const passes = (ixs: Instruction[], side: Side) =>
    expect(validateSolanaTx(budget(ixs), ctx(side)).actions.filter((a) => !a.ok)).toEqual([]);

  // The minimums are loose so a trade by someone else in between cannot fail the run; the
  // quotes are checked exactly below, against the state the programs themselves traded on.
  const amount = await buyAmount(owner, route, payMeta.decimals);
  let tokens: bigint;
  let buy: Instruction[] = [];
  if (amount > 0n) {
    const quoted = routeBuyQuote(route, amount);
    expect(quoted).toBeGreaterThan(0n);
    buy = buyInstructions(route, owner, amount, quoted / 2n, rec).instructions;
    passes(buy, 'buy');
    tokens = quoted / 4n;
  } else {
    const holding = await held(owner, { mint: coin.mint, program: coin.tokenProgram });
    expect(holding, 'no funds to buy, and nothing held to sell').toBeGreaterThan(0n);
    tokens = holding / 10n || holding;
  }
  const sell = sellInstructions(route, owner, tokens, 1n, rec).instructions;
  passes(sell, 'sell');

  const result = { buyUnits: 0, sellUnits: 0, bought: buy.length > 0, bytes: 0 };
  const run = async (part: Instruction[], side: Side, amountIn: bigint) => {
    const sim = await simulate(owner, budget(part));
    expect(sim.err, sim.logs).toBeNull();
    const { before, out } = replay(route, side, sim.inner());
    const quote =
      side === 'buy' ? routeBuyQuote(before, amountIn) : routeSellQuote(before, amountIn);
    expect(quote).toBe(out);
    result[side === 'buy' ? 'buyUnits' : 'sellUnits'] = sum(unitsPerInstruction(sim.logs));
    result.bytes = Math.max(result.bytes, sim.bytes);
  };
  const together = buy.length > 0 ? budget([...buy, ...sell]) : null;
  const fits =
    together !== null &&
    compileMessage(owner, together, DEFAULT_BLOCKHASH).bytes.length + 65 <= MAX_TX_BYTES;
  if (!fits) {
    // Too big for one transaction (two-hop routes): each on its own, selling what is held.
    if (buy.length > 0) await run(buy, 'buy', amount);
    const holding = await held(owner, { mint: coin.mint, program: coin.tokenProgram });
    if (holding === 0n) return result;
    const part = holding / 10n || holding;
    await run(sellInstructions(route, owner, part, 1n, rec).instructions, 'sell', part);
    return result;
  }

  const sim = await simulate(owner, together);
  expect(sim.err, sim.logs).toBeNull();
  const split = 2 + buy.length;
  const units = unitsPerInstruction(sim.logs);
  const bought = replay(route, 'buy', sim.inner(0, split));
  expect(routeBuyQuote(bought.before, amount)).toBe(bought.out);
  const sold = replay(route, 'sell', sim.inner(split));
  expect(routeSellQuote(sold.before, tokens)).toBe(sold.out);
  return {
    ...result,
    buyUnits: sum(units.slice(0, split)),
    sellUnits: sum(units.slice(split)),
    bytes: sim.bytes,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('pump.fun (Solana mainnet simulation, no funds)', () => {
  beforeAll(async () => {
    await scan(PUMP_PROGRAM, 80, ['curve-v3', 'curve-v2']);
    await scan(PUMP_AMM_PROGRAM, 120, ['pool-v2', 'pool-v1', 'multi-hop']);
    // Token-quoted trades pay their buyback into the first listed wallet's token account.
    const usdcBuyback = associatedTokenAddress(BUYBACK_FEE_RECIPIENTS[0] ?? '', USDC_MINT);
    await scan(usdcBuyback, 40, ['token-pay', 'multi-hop']);
  }, 900_000);

  /** Runs `body` on the coin found for `kind`, or skips when none traded recently. */
  const onLive =
    (kind: Kind, body: (f: Found) => Promise<void>) =>
    async (t: { skip: (note?: string) => void }) => {
      const list = catalog.get(kind) ?? [];
      if (list.length === 0) {
        t.skip(`no ${kind} coin among recent trades`);
        return;
      }
      for (const f of list) if (await canTrade(f)) return body(f);
      t.skip(`every recent ${kind} trader has sold out and has no funds left`);
    };

  it(
    'buys and sells on a bonding curve',
    onLive('curve-v3', async (f) => {
      const units = await roundTrip(f);
      expect(units.buyUnits).toBeLessThan(220_000);
      expect(units.sellUnits).toBeLessThan(160_000);
      // A page may name the mint or its curve: both resolve to the mint.
      expect((await service.resolve(f.mint, 'token'))?.mint).toBe(f.mint);
      const viaCurve = await service.resolve(bondingCurveAddress(f.mint), 'pair');
      expect(viaCurve).toMatchObject({ kind: 'solana', mint: f.mint, source: 'pair' });
    }),
  );

  it(
    'buys and sells a cashback coin on its curve (v2)',
    onLive('curve-v2', async (f) => {
      const units = await roundTrip(f);
      expect(units.buyUnits).toBeLessThan(260_000);
      expect(units.sellUnits).toBeLessThan(200_000);
    }),
  );

  it(
    'buys and sells on a PumpSwap pool',
    onLive('pool-v2', async (f) => {
      const units = await roundTrip(f);
      expect(units.buyUnits).toBeLessThan(300_000);
      expect(units.sellUnits).toBeLessThan(240_000);
      const viaPool = await service.resolve(canonicalPoolAddress(f.mint), 'pair');
      expect(viaPool).toMatchObject({ kind: 'solana', mint: f.mint, source: 'pair' });
    }),
  );

  it(
    'buys and sells on a cashback or mayhem pool (v1)',
    onLive('pool-v1', async (f) => {
      const units = await roundTrip(f);
      expect(units.buyUnits).toBeLessThan(320_000);
      expect(units.sellUnits).toBeLessThan(280_000);
    }),
  );

  it(
    'buys and sells a coin paired with a token',
    onLive('token-pay', async (f) => {
      const r = await roundTrip(f);
      expect(r.sellUnits).toBeGreaterThan(0);
    }),
  );

  it(
    'buys and sells through two hops in one transaction',
    onLive('multi-hop', async (f) => {
      const r = await roundTrip(f);
      expect(r.bytes).toBeLessThanOrEqual(1232);
    }),
  );

  it(
    'sends SOL and a coin to a new address, within the compute it asks for',
    onLive('curve-v3', async (f) => {
      const owner = f.trader;
      const { route } = await service.route(f.mint, 0);
      if (!route) throw new Error(`${f.mint} no longer trades`);
      const coin = routeCoin(route);
      const program = coin.tokenProgram;
      // A fresh random address: nothing was ever sent to it.
      const friend = base58.encode(crypto.getRandomValues(new Uint8Array(32)));
      const meta = await service.tokenMeta(f.mint);
      // What an account must hold to exist, as the chain sets it now.
      const minBalance = await rpc.minimumBalance(0);

      // What the Send form tells about each kind of address.
      const check = (to: string, mint?: string) =>
        service.transfers.checkRecipient({ to, ...(mint ? { mint } : {}) }, []);
      const accountRent = await rpc.minimumBalance(tokenAccountSize(program, meta?.extensions));
      // A trader who sold out may have closed their token account (bots do, for the rent).
      const ata = associatedTokenAddress(owner, f.mint, program);
      const hasAccount = (await rpc.getAccount(ata)) !== null;
      expect((await check(f.mint)).kind).toBe('mint');
      expect(await check(owner, f.mint)).toMatchObject({
        kind: 'wallet',
        tokenAccountRent: hasAccount ? '0' : accountRent.toString(),
      });
      expect((await check(bondingCurveAddress(f.mint))).kind).toBe('program-account');
      expect((await check(PUMP_PROGRAM)).kind).toBe('program');
      if (hasAccount) expect(await check(ata)).toMatchObject({ kind: 'token-account', owner });
      expect((await check(friend, f.mint)).tokenAccountRent).toBe(accountRent.toString());

      // Built as Send builds them, with the compute it asks for when not simulating first.
      const failed = (ixs: Instruction[], ctx: SolTransferContext) =>
        validateSolanaTransfer(ixs, ctx).actions.filter((a) => !a.ok);
      const base = { wallet: owner, to: friend, maxPriorityLamports: 10_000_000n };
      let sent = 0;
      if ((await rpc.getBalance(owner)) > 3_000_000n) {
        const ixs = [
          setComputeUnitLimit(SOL_UNITS),
          setComputeUnitPrice(1_000n),
          transfer(owner, friend, minBalance),
        ];
        expect(failed(ixs, { ...base, asset: null, amount: minBalance })).toEqual([]);
        const sim = await simulate(owner, ixs);
        expect(sim.err, sim.logs).toBeNull();
        expect(sim.units).toBeLessThanOrEqual(SOL_UNITS);
        sent++;

        // Emptying a wallet: Solana takes the fee first and checks the balance then, so what
        // the fee leaves must be zero or enough to exist, though the transfer then takes all
        // of it. Sent to an account that exists, so only the payer's balance is in question.
        const sink = bondingCurveAddress(f.mint);
        for (let attempt = 1; ; attempt++) {
          const before = await rpc.getBalance(owner);
          const empty = (afterFee: bigint) => [
            setComputeUnitLimit(1_000),
            // 1,000 units at this price: a priority fee of exactly what leaves `afterFee`.
            setComputeUnitPrice((before - 5_000n - afterFee) * 1_000n),
            transfer(owner, sink, afterFee),
          ];
          const [below, at] = await Promise.all([
            simulate(owner, empty(minBalance - 1n)),
            simulate(owner, empty(minBalance)),
          ]);
          // The trader may have traded meanwhile: then the fee no longer adds up.
          const steady = below.payerBalance === before && at.payerBalance === before;
          if (!steady && attempt < 5) continue;
          expect(steady).toBe(true);
          // Refused before running: the fee left too little.
          expect(below.err).toEqual({ InsufficientFundsForRent: { account_index: 0 } });
          expect(below.units).toBe(0);
          expect(at.err, at.logs).toBeNull();
          break;
        }
      }
      const holding = await held(owner, { mint: f.mint, program });
      if (holding > 0n && meta) {
        const amount = holding / 10n || holding;
        const ixs = [
          setComputeUnitLimit(TOKEN_UNITS),
          setComputeUnitPrice(1_000n),
          createAtaIdempotent(friend, f.mint, program, owner),
          transferChecked(owner, friend, f.mint, program, amount, meta.decimals),
        ];
        const asset = { mint: f.mint, program, decimals: meta.decimals, symbol: meta.symbol };
        expect(failed(ixs, { ...base, asset, amount })).toEqual([]);
        const sim = await simulate(owner, ixs);
        expect(sim.err, sim.logs).toBeNull();
        expect(sim.units).toBeLessThanOrEqual(TOKEN_UNITS);
        sent++;
      }
      expect(sent).toBeGreaterThan(0);
    }),
  );

  it('reads a known token of a wallet without listing its accounts', async (t) => {
    const f = catalog.get('curve-v3')?.[0];
    if (!f) {
      t.skip('no curve coin among recent trades');
      return;
    }
    // The curve holds its own coin in its associated account, like a wallet would.
    const holder = bondingCurveAddress(f.mint);
    const watcher = new SolanaService({
      vault: {
        listAccounts: async () => [
          { id: 'w', name: 'W', hidden: false, primary: true, kind: 'derived', solana: holder },
        ],
      } as never,
      settings: new SettingsStore(new MemoryStore()),
      local: new MemoryStore(),
      history: { list: async () => [] },
      notify: () => undefined,
      now: Date.now,
    });
    await watcher.setTrusted(f.mint, true);
    const p = await watcher.portfolio(['w']);
    const token = p.tokens.find((x) => x.address === f.mint);
    expect(BigInt(token?.perWallet.w ?? '0')).toBeGreaterThan(0n);
    expect(token?.unsolicited).toBe(false);
    expect(token?.valueUsd).toBeGreaterThan(0);
  });

  it('values SOL from the Orca pool', async () => {
    const usd = await service.price.usd();
    expect(usd).toBeGreaterThan(1);
    expect(usd).toBeLessThan(100_000);
  });

  it("shows a coin's own image from its metadata on IPFS, and the chain's mark", async (t) => {
    // Coins launched on pump.fun name their metadata on IPFS. Those launched through other
    // tools may name any host, which Nesty never contacts: they get DEX Screener's logo.
    const onIpfs: (Found & { uri: string })[] = [];
    for (const f of [...catalog.values()].flat().slice(0, 12)) {
      const uri = (await service.tokenMeta(f.mint))?.uri;
      if (uri && ipfsCid(uri)) onIpfs.push({ ...f, uri });
      if (onIpfs.length === 3) break;
    }
    if (onIpfs.length === 0) {
      t.skip('no recent coin names its metadata on IPFS');
      return;
    }
    const decode = globalThis.createImageBitmap;
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    // Node has no image decoder: whether the bytes decode is the browser's to check.
    globalThis.createImageBitmap = (async () => ({ close() {} })) as never;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const logos = new LogoService(new MemoryStore());
      let fromIpfs = 0;
      for (const c of onIpfs) {
        asked.length = 0;
        const url = await logos.solana(c.mint, c.uri);
        // Metadata and image both from the gateway, with no fallback to DEX Screener.
        if (url && asked.every((u) => u.startsWith(IPFS_GATEWAY))) fromIpfs++;
      }
      expect(fromIpfs).toBeGreaterThan(0);
      expect(await logos.chain('solana')).toMatch(/^data:image\/png;base64,/);
    } finally {
      globalThis.createImageBitmap = decode;
      globalThis.fetch = realFetch;
    }
  });
});
