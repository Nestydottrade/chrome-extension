import type { SolAddress } from '../../../shared/solana';
import {
  DEFAULT_KEY,
  SYSVAR_CLOCK,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  coinOfPair,
  findProgramAddress,
  seed,
} from '../address';
import { Reader, decodeClock, hasDiscriminator, type ChainClock } from '../layouts';
import type { Side } from '../pump';
import { concat, meta, u64, type Instruction } from '../tx';
import { userAccounts } from './accounts';
import { U64_MAX, fitU64 } from './meteora-math';
import { quoteOrZero, refuse } from './refusal';
import type { DexModule, DexVenueBase } from './types';

/**
 * Meteora DLMM (lb_clmm): liquidity in discrete bins, each trading at its own fixed price,
 * 70 bins to an array. Facts from Meteora's SDK (MeteoraAg/dlmm-sdk, its exact-input
 * quote): a swap empties bins one at a time from the active bin, market makers' liquidity
 * first and then the bin's limit orders (processed, then open); the fee is a base fee set
 * by the bin step plus a variable fee that grows with the bins crossed since the last quiet
 * spell, and comes off the input, or off the output when a pool collects only token Y and Y
 * comes out.
 */
export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const EVENT_AUTHORITY = findProgramAddress([seed('__event_authority')], METEORA_DLMM_PROGRAM);
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const PAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13];
const ARRAY_DISC = [92, 142, 92, 220, 5, 148, 70, 181];
const SWAP2 = [65, 75, 63, 76, 235, 91, 91, 136];
const PAIR_SIZE = 904;
const BINS = 70;
const BIN_SIZE = 144;
const ARRAY_SIZE = 56 + BINS * BIN_SIZE;
const MIN_BIN_ID = -443636;
const MAX_BIN_ID = 443636;
/** The pair's own bitmap covers arrays -512..511; past them an extension account does. */
const BITMAP_HALF = 512;
/** Arrays read each way from the active bin: a swap that needs more is not quoted. */
const ARRAYS_EACH_WAY = 3;
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const BPS = 10_000;
/** Pair types whose swaps wait for the activation point. */
const PERMISSIONED = [1, 2];
const LIMIT_ORDER = 2;
const UNDETERMINED = 0;
/**
 * A trade's compute, measured on mainnet for whole transactions (accounts and wrapping
 * included): up to about 61k through one bin, and 5.5k to 5.8k more for each further bin it
 * takes liquidity from. Stepping across an empty bin went unmeasured, so it is given some.
 */
const UNITS = 200_000;
const UNITS_FIRST_BIN = 70_000;
const UNITS_PER_BIN = 6_000;
const UNITS_PER_STEP = 400;

/** The fee's settings and the volatility state it moves with. */
interface DlmmFee {
  baseFactor: number;
  powerFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatility: number;
  volatility: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdate: bigint;
}

/** A bin with something in it. */
interface DlmmBin {
  id: number;
  x: bigint;
  y: bigint;
  /** Token Y per token X, in Q64.64. */
  price: bigint;
  /** Limit orders resting in the bin: selling X (ask) or Y (bid). */
  orders: { ask: boolean; open: bigint; processed: bigint } | null;
}

interface DlmmArray {
  index: number;
  bins: DlmmBin[];
}

export interface MeteoraDlmmVenue extends DexVenueBase<'meteora-dlmm'> {
  /** Whether the coin is the pair's token X (else token Y). */
  coinIsX: boolean;
  reserveX: SolAddress;
  reserveY: SolAddress;
  oracle: SolAddress;
  status: number;
  pairType: number;
  activationType: number;
  activationPoint: bigint;
  /** The chain's clock when the pair was read: the variable fee decays with it. */
  clock: ChainClock;
  binStep: number;
  activeId: number;
  fee: DlmmFee;
  /** Whether bins fill limit orders after market makers' liquidity. */
  limitOrders: boolean;
  /** Fees in token Y only: off the output when Y comes out. */
  feeInY: boolean;
  /** The arrays holding liquidity a swap walks, nearest first: down as X goes in, up as Y. */
  down: DlmmArray[];
  up: DlmmArray[];
}

interface PairState {
  fee: DlmmFee;
  functionType: number;
  collectFeeMode: number;
  pairType: number;
  activeId: number;
  binStep: number;
  status: number;
  activationType: number;
  mintX: SolAddress;
  mintY: SolAddress;
  reserveX: SolAddress;
  reserveY: SolAddress;
  rewardMints: SolAddress[];
  oracle: SolAddress;
  bitmap: bigint;
  activationPoint: bigint;
  flagX: number;
  flagY: number;
}

/** LbPair: zero-copy, so at fixed offsets after the discriminator. */
export function decodeDlmmPair(data: Uint8Array): PairState | null {
  if (data.length !== PAIR_SIZE || !hasDiscriminator(data, PAIR_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  let bitmap = 0n;
  for (let i = 0; i < 16; i++) bitmap |= at(584 + i * 8).u64() << BigInt(64 * i);
  return {
    fee: {
      baseFactor: at(8).u16(),
      filterPeriod: at(10).u16(),
      decayPeriod: at(12).u16(),
      reductionFactor: at(14).u16(),
      variableFeeControl: at(16).u32(),
      maxVolatility: at(20).u32(),
      powerFactor: data[34] ?? 0,
      volatility: at(40).u32(),
      volatilityReference: at(44).u32(),
      indexReference: at(48).u32() | 0,
      lastUpdate: BigInt.asIntN(64, at(56).u64()),
    },
    functionType: data[35] ?? 0,
    collectFeeMode: data[36] ?? 0,
    pairType: data[75] ?? 0,
    activeId: at(76).u32() | 0,
    binStep: at(80).u16(),
    status: data[82] ?? 0,
    activationType: data[86] ?? 0,
    mintX: at(88).pubkey(),
    mintY: at(120).pubkey(),
    reserveX: at(152).pubkey(),
    reserveY: at(184).pubkey(),
    rewardMints: [at(264).pubkey(), at(408).pubkey()],
    oracle: at(552).pubkey(),
    bitmap,
    activationPoint: at(816).u64(),
    flagX: data[880] ?? 0,
    flagY: data[881] ?? 0,
  };
}

/** A bin array of `pair`'s, its bins with anything in them; null when it is none of its. */
function decodeBinArray(
  data: Uint8Array,
  pair: SolAddress,
  limitOrders: boolean,
): DlmmArray | null {
  if (data.length !== ARRAY_SIZE || !hasDiscriminator(data, ARRAY_DISC)) return null;
  const at = (o: number) => new Reader(data, o);
  if (at(24).pubkey() !== pair) return null;
  const index = Number(BigInt.asIntN(64, at(8).u64()));
  const bins: DlmmBin[] = [];
  for (let i = 0; i < BINS; i++) {
    const o = 56 + i * BIN_SIZE;
    const x = at(o).u64();
    const y = at(o + 8).u64();
    // Without limit orders these bytes hold other things.
    const open = limitOrders ? at(o + 112).u64() : 0n;
    const processed = limitOrders ? at(o + 128).u64() : 0n;
    if (x === 0n && y === 0n && open === 0n && processed === 0n) continue;
    bins.push({
      id: index * BINS + i,
      x,
      y,
      price: at(o + 16).u128(),
      orders: open > 0n || processed > 0n ? { ask: data[o + 140] !== 0, open, processed } : null,
    });
  }
  return { index, bins };
}

const binArrayAddress = (pair: SolAddress, index: number) =>
  findProgramAddress(
    [seed('bin_array'), pair, u64(BigInt.asUintN(64, BigInt(index)))],
    METEORA_DLMM_PROGRAM,
  );

const arrayIndexOf = (binId: number) => Math.floor(binId / BINS);

/** The first `n` arrays holding liquidity from `start` one way, by the pair's bitmap. */
function withLiquidity(bitmap: bigint, start: number, down: boolean, n: number): number[] {
  const out: number[] = [];
  for (let i = start; out.length < n && i >= -BITMAP_HALF && i < BITMAP_HALF; i += down ? -1 : 1)
    if ((bitmap >> BigInt(i + BITMAP_HALF)) & 1n) out.push(i);
  return out;
}

const flagProgram = (flag: number) =>
  flag === 0 ? TOKEN_PROGRAM : flag === 1 ? TOKEN_2022_PROGRAM : null;

/** Slot or Unix time, as the pair's activation counts. */
const pointOf = (v: MeteoraDlmmVenue) => (v.activationType === 0 ? v.clock.slot : v.clock.unixTime);

/** Whether `side` sells token X for token Y. */
const forY = (v: MeteoraDlmmVenue, side: Side) => (side === 'sell') === v.coinIsX;

/** The fee rate (of 10^9) at the fee state's volatility, capped at 10%. */
function feeRate(v: MeteoraDlmmVenue, f: DlmmFee): bigint {
  const step = BigInt(v.binStep);
  const base = BigInt(f.baseFactor) * step * 10n * 10n ** BigInt(f.powerFactor);
  const crossed = BigInt(f.volatility) * step;
  const variable =
    f.variableFeeControl > 0
      ? (BigInt(f.variableFeeControl) * crossed * crossed + 99_999_999_999n) / 100_000_000_000n
      : 0n;
  return base + variable < MAX_FEE_RATE ? base + variable : MAX_FEE_RATE;
}

/** The fee within an amount that includes it, rounded up (`compute_fee_from_amount`). */
const feeWithin = (amount: bigint, rate: bigint) =>
  fitU64((amount * rate + FEE_PRECISION - 1n) / FEE_PRECISION);

/** The fee to add on top of an amount, rounded up (`compute_fee`). */
const feeOnTop = (amount: bigint, rate: bigint) =>
  fitU64((amount * rate + FEE_PRECISION - rate - 1n) / (FEE_PRECISION - rate));

const ceilDiv = (a: bigint, b: bigint) => (b === 0n ? refuse() : (a + b - 1n) / b);

/** What `amountIn` buys at a bin's price, rounded down. */
const amountOut = (amountIn: bigint, price: bigint, swapForY: boolean) =>
  fitU64(
    swapForY ? (price * amountIn) >> 64n : price === 0n ? refuse() : (amountIn << 64n) / price,
  );

/** What buying `out` costs at a bin's price, rounded up. */
const amountIn = (out: bigint, price: bigint, swapForY: boolean) =>
  fitU64(swapForY ? ceilDiv(out << 64n, price) : ceilDiv(out * price, 1n << 64n));

/** How much of `amount` one layer of a bin's liquidity takes, and what it pays. */
function fill(amount: bigint, available: bigint, price: bigint, swapForY: boolean) {
  if (available === 0n) return { used: 0n, paid: 0n };
  const need = amountIn(available, price, swapForY);
  return amount >= need
    ? { used: need, paid: available }
    : { used: amount, paid: amountOut(amount, price, swapForY) };
}

/** The limit orders of a bin that `swapForY` fills: bids as X goes in, asks as Y does. */
const ordersFor = (bin: DlmmBin, swapForY: boolean) =>
  bin.orders && bin.orders.ask !== swapForY ? bin.orders : null;

/** A bin's layers in turn: market makers, then processed orders, then open ones. */
function fillBin(v: MeteoraDlmmVenue, bin: DlmmBin, amount: bigint, swapForY: boolean) {
  const mm = fill(amount, swapForY ? bin.y : bin.x, bin.price, swapForY);
  let { used, paid } = mm;
  const orders = v.limitOrders ? ordersFor(bin, swapForY) : null;
  if (orders && amount > used) {
    for (const available of [orders.processed, orders.open]) {
      if (amount === used) break;
      const layer = fill(amount - used, available, bin.price, swapForY);
      used += layer.used;
      paid = fitU64(paid + layer.paid);
    }
  }
  return { used, paid };
}

/** One bin's share of an exact-input swap (`swap_exact_in_quote_at_bin`). */
function swapAtBin(
  v: MeteoraDlmmVenue,
  rate: bigint,
  bin: DlmmBin,
  inAmount: bigint,
  swapForY: boolean,
) {
  const feeOnInput = !(v.feeInY && swapForY);
  let net = feeOnInput ? inAmount - feeWithin(inAmount, rate) : inAmount;
  const { used, paid } = fillBin(v, bin, net, swapForY);
  let gross = inAmount;
  // A bin emptied before the input ran out takes only what filled it, and its fee.
  if (net > used) {
    net = used;
    gross = feeOnInput ? fitU64(net + feeOnTop(net, rate)) : net;
  }
  return { amountIn: gross, amountOut: feeOnInput ? paid : paid - feeWithin(paid, rate) };
}

/**
 * An exact-input swap of `amount`, bin by bin as the program walks them: what it pays, and
 * the bins it took liquidity from and stepped across (its compute grows with both).
 */
function walk(v: MeteoraDlmmVenue, amount: bigint, swapForY: boolean) {
  const f = { ...v.fee };
  // update_references: a quiet spell resets the reference to the active bin, and decays.
  const elapsed = v.clock.unixTime - f.lastUpdate;
  if (elapsed >= BigInt(f.filterPeriod)) {
    f.indexReference = v.activeId;
    if (elapsed < BigInt(f.decayPeriod)) {
      const decayed = f.volatility * f.reductionFactor;
      if (decayed > 0xffff_ffff) refuse();
      f.volatilityReference = Math.floor(decayed / BPS);
    } else {
      f.volatilityReference = 0;
    }
  }
  const arrays = swapForY ? v.down : v.up;
  let left = amount;
  let out = 0n;
  let active = v.activeId;
  let filled = 0;
  let steps = 0;
  for (let next = 0; left > 0n; next++) {
    const a = arrays[next] ?? refuse();
    const lower = a.index * BINS;
    const upper = lower + BINS - 1;
    // Past an empty stretch, the swap starts at the array's near edge.
    if (arrayIndexOf(active) !== a.index) active = swapForY ? upper : lower;
    const bins = new Map(a.bins.map((b) => [b.id, b]));
    while (active >= lower && active <= upper && left > 0n) {
      const bin = bins.get(active);
      const orders = bin && v.limitOrders ? ordersFor(bin, swapForY) : null;
      const available = bin
        ? (swapForY ? bin.y : bin.x) + (orders ? orders.open + orders.processed : 0n)
        : 0n;
      if (bin && available > 0n) {
        f.volatility = Math.min(
          f.volatilityReference + Math.abs(f.indexReference - active) * BPS,
          f.maxVolatility,
        );
        const step = swapAtBin(v, feeRate(v, f), bin, left, swapForY);
        if (step.amountIn > left) refuse();
        left -= step.amountIn;
        out = fitU64(out + step.amountOut);
        filled++;
      }
      if (left > 0n) {
        active += swapForY ? -1 : 1;
        steps++;
        if (active < MIN_BIN_ID || active > MAX_BIN_ID) refuse();
      }
    }
  }
  return { out, filled, steps };
}

/** Each pair's arrays read last time, to read along with it next time. */
const lastRead = new Map<SolAddress, number[]>();

export const meteoraDlmm: DexModule<MeteoraDlmmVenue> = {
  dex: 'meteora-dlmm',
  program: METEORA_DLMM_PROGRAM,
  units: UNITS,

  unitsFor(v, side, amountIn) {
    try {
      const { filled, steps } = walk(v, amountIn, forY(v, side));
      return UNITS_FIRST_BIN + UNITS_PER_BIN * Math.max(0, filled - 1) + UNITS_PER_STEP * steps;
    } catch {
      // A swap the pool cannot fill fails on chain whatever it is given.
      return UNITS;
    }
  },

  async load(ctx, pool, mint) {
    const before = lastRead.get(pool) ?? [];
    const accs = await ctx.read([
      pool,
      SYSVAR_CLOCK,
      ...before.map((index) => binArrayAddress(pool, index)),
    ]);
    const [pairAcc = null, clockAcc = null] = accs;
    if (pairAcc?.owner !== METEORA_DLMM_PROGRAM) return null;
    const s = decodeDlmmPair(pairAcc.data);
    const clock = clockAcc ? decodeClock(clockAcc.data) : null;
    if (!s || !clock || s.collectFeeMode > 1 || s.functionType > LIMIT_ORDER) return null;
    const coinIsX = s.mintX === mint;
    if (!coinIsX && s.mintY !== mint) return null;
    if (flagProgram(coinIsX ? s.flagX : s.flagY) !== ctx.coinProgram) return null;
    const quote = await ctx.quoteAsset(coinIsX ? s.mintY : s.mintX);
    if (!quote || quote.program !== flagProgram(coinIsX ? s.flagY : s.flagX)) return null;
    // Bins past the pair's own bitmap need its extension account: not quoted.
    const active = arrayIndexOf(s.activeId);
    if (active < -BITMAP_HALF || active >= BITMAP_HALF) return null;

    const downIndexes = withLiquidity(s.bitmap, active, true, ARRAYS_EACH_WAY);
    const upIndexes = withLiquidity(s.bitmap, active, false, ARRAYS_EACH_WAY);
    const needed = [...new Set([...downIndexes, ...upIndexes])];
    const got = new Map(before.map((index, i) => [index, accs[2 + i] ?? null]));
    const missing = needed.filter((index) => !got.has(index));
    if (missing.length > 0) {
      const more = await ctx.read(missing.map((index) => binArrayAddress(pool, index)));
      missing.forEach((index, i) => got.set(index, more[i] ?? null));
    }
    const limitOrders =
      s.functionType === LIMIT_ORDER ||
      (s.functionType === UNDETERMINED && s.rewardMints.every((m) => m === DEFAULT_KEY));
    const arrays = new Map<number, DlmmArray>();
    for (const index of needed) {
      const acc = got.get(index) ?? null;
      const a =
        acc?.owner === METEORA_DLMM_PROGRAM ? decodeBinArray(acc.data, pool, limitOrders) : null;
      if (!a || a.index !== index) return null;
      arrays.set(index, a);
    }
    if (lastRead.size > 200) lastRead.clear();
    lastRead.set(pool, needed);
    const pick = (indexes: number[]) => indexes.flatMap((index) => arrays.get(index) ?? []);
    return {
      kind: 'dex',
      dex: 'meteora-dlmm',
      pool,
      mint,
      tokenProgram: ctx.coinProgram,
      quote,
      coinIsX,
      reserveX: s.reserveX,
      reserveY: s.reserveY,
      oracle: s.oracle,
      status: s.status,
      pairType: s.pairType,
      activationType: s.activationType,
      activationPoint: s.activationPoint,
      clock,
      binStep: s.binStep,
      activeId: s.activeId,
      fee: s.fee,
      limitOrders,
      feeInY: s.collectFeeMode === 1,
      down: pick(downIndexes),
      up: pick(upIndexes),
    };
  },

  coinOf(data) {
    const s = decodeDlmmPair(data);
    return s ? coinOfPair(s.mintX, s.mintY) : null;
  },

  label: () => 'Meteora DLMM',

  quote(v, side, amountIn) {
    return quoteOrZero(() =>
      amountIn > 0n && amountIn <= U64_MAX ? walk(v, amountIn, forY(v, side)).out : 0n,
    );
  },

  spot(v) {
    const price = (1 + v.binStep / BPS) ** v.activeId;
    return v.coinIsX ? price : price > 0 ? 1 / price : 0;
  },

  idle(v) {
    if (v.status !== 0) return 'Meteora has disabled swaps on this pool.';
    if (PERMISSIONED.includes(v.pairType) && pointOf(v) < v.activationPoint)
      return 'This Meteora pool has not opened yet.';
    return null;
  },

  swap(v, side, user, amountIn, minOut) {
    const { source, destination } = userAccounts(v, side, user);
    const coin = { mint: v.mint, program: v.tokenProgram };
    const quote = { mint: v.quote.mint, program: v.quote.program };
    const [x, y] = v.coinIsX ? [coin, quote] : [quote, coin];
    return {
      programId: METEORA_DLMM_PROGRAM,
      keys: [
        meta(v.pool, true),
        // No bitmap extension (quotes stay within the pair's own bitmap) and no host fee:
        // the program's own address stands in for each.
        meta(METEORA_DLMM_PROGRAM),
        meta(v.reserveX, true),
        meta(v.reserveY, true),
        meta(source, true),
        meta(destination, true),
        meta(x.mint),
        meta(y.mint),
        meta(v.oracle, true),
        meta(METEORA_DLMM_PROGRAM),
        meta(user, false, true),
        meta(x.program),
        meta(y.program),
        meta(MEMO_PROGRAM),
        meta(EVENT_AUTHORITY),
        meta(METEORA_DLMM_PROGRAM),
        // The bin arrays the swap may walk, in order.
        ...(forY(v, side) ? v.down : v.up).map((a) => meta(binArrayAddress(v.pool, a.index), true)),
      ],
      // No transfer-hook accounts: an empty list of slices.
      data: concat(SWAP2, u64(amountIn), u64(minOut), [0, 0, 0, 0]),
    } satisfies Instruction;
  },

  amounts(data) {
    if (data.length !== 28 || !hasDiscriminator(data, SWAP2)) return null;
    const r = new Reader(data, 8);
    const amounts = { amountIn: r.u64(), minOut: r.u64() };
    return r.u32() === 0 ? amounts : null;
  },
};
