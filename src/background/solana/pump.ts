import type { SolAddress } from '../../shared/solana';
import {
  ATA_PROGRAM,
  DEFAULT_KEY,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
  findProgramAddress,
  seed,
} from './address';
import { Reader, hasDiscriminator } from './layouts';
import { closeAccount, createAtaIdempotent, syncNative, transfer, wsolAccount } from './spl';
import { concat, meta, u64, type AccountMeta, type Instruction } from './tx';

// pump.fun's bonding curve program, its AMM (PumpSwap) and the fee program both read.
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

/** pump PDA ["global"]. */
export const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
/** Pump Fees PDA ["fee_config", pump]. */
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
/** PumpSwap PDA ["global_config"]. */
export const AMM_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';
/** Pump Fees PDA ["fee_config", pump amm]. */
export const AMM_FEE_CONFIG = '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx';

/**
 * The buyback fee recipients pump.fun lists for every coin (docs: FEE_RECIPIENTS.md), in
 * the programs' order. A trade names one of them; Nesty only ever names one from this list.
 */
export const BUYBACK_FEE_RECIPIENTS: readonly SolAddress[] = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

const DISC = {
  global: [167, 232, 232, 177, 200, 108, 114, 127],
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  feeConfig: [143, 52, 146, 187, 219, 123, 76, 155],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
  globalConfig: [149, 8, 156, 202, 160, 252, 176, 217],
} as const;

export const IX = {
  buyExactQuoteInV3: [225, 247, 80, 30, 213, 179, 132, 136],
  sellV3: [28, 146, 222, 119, 38, 196, 105, 213],
  /** pump's curve and PumpSwap share these two: same names, same discriminators. */
  buyExactQuoteInV2: [194, 171, 28, 70, 104, 77, 91, 47],
  sellV2: [93, 246, 130, 60, 231, 233, 64, 178],
  /** PumpSwap v1: the only trades cashback and mayhem pools take. */
  ammBuyExactQuoteIn: [198, 46, 21, 82, 180, 217, 232, 112],
  ammSell: [51, 230, 133, 164, 1, 127, 131, 173],
  multiHopSwap: [43, 100, 73, 19, 233, 246, 111, 148],
  /** Both programs: pays out the cashback in the wallet's volume accumulator. */
  claimCashback: [37, 58, 35, 126, 190, 53, 228, 197],
} as const;

/** pump's market-cap basis for every coin but mayhem ones (1 billion, 6 decimals). */
const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;
const BPS = 10_000n;

export type Side = 'buy' | 'sell';

// ── PDAs ────────────────────────────────────────────────────────────────────

export const bondingCurveAddress = (mint: SolAddress) =>
  findProgramAddress([seed('bonding-curve'), mint], PUMP_PROGRAM);
export const pumpEventAuthority = () =>
  findProgramAddress([seed('__event_authority')], PUMP_PROGRAM);
export const pumpVolumeAccumulator = (user: SolAddress) =>
  findProgramAddress([seed('user_volume_accumulator'), user], PUMP_PROGRAM);
export const pumpGlobalVolumeAccumulator = () =>
  findProgramAddress([seed('global_volume_accumulator')], PUMP_PROGRAM);
/** Where v2 curve trades pay a coin's creator fee. */
export const creatorVaultAddress = (creator: SolAddress) =>
  findProgramAddress([seed('creator-vault'), creator], PUMP_PROGRAM);
export const sharingConfigAddress = (mint: SolAddress) =>
  findProgramAddress([seed('sharing-config'), mint], PUMP_FEES_PROGRAM);
export const poolAuthority = (mint: SolAddress) =>
  findProgramAddress([seed('pool-authority'), mint], PUMP_PROGRAM);
/** The pool a pump coin migrates to: index 0, created by its pool authority, in its quote. */
export const canonicalPoolAddress = (mint: SolAddress, quoteMint: SolAddress = WSOL_MINT) =>
  findProgramAddress(
    [seed('pool'), Uint8Array.of(0, 0), poolAuthority(mint), mint, quoteMint],
    PUMP_AMM_PROGRAM,
  );
export const ammEventAuthority = () =>
  findProgramAddress([seed('__event_authority')], PUMP_AMM_PROGRAM);
export const ammVolumeAccumulator = (user: SolAddress) =>
  findProgramAddress([seed('user_volume_accumulator'), user], PUMP_AMM_PROGRAM);
export const ammGlobalVolumeAccumulator = () =>
  findProgramAddress([seed('global_volume_accumulator')], PUMP_AMM_PROGRAM);
/** Owns the quote account v1 pool trades pay the creator fee into. */
export const ammCreatorVaultAuthority = (coinCreator: SolAddress) =>
  findProgramAddress([seed('creator_vault'), coinCreator], PUMP_AMM_PROGRAM);
export const poolV2Address = (mint: SolAddress) =>
  findProgramAddress([seed('pool-v2'), mint], PUMP_AMM_PROGRAM);

// ── accounts ────────────────────────────────────────────────────────────────

export interface Fees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface FeeTier {
  threshold: bigint;
  fees: Fees;
}

export interface FeeConfig {
  flatFees: Fees;
  feeTiers: FeeTier[];
  stableFeeTiers: FeeTier[];
  exoticFlatFees: Fees;
}

export interface PumpGlobal {
  poolMigrationFee: bigint;
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
  /** Where v2 curve trades may send the protocol fee (unset slots left out). */
  feeRecipients: SolAddress[];
  /** The same, for mayhem coins. */
  reservedFeeRecipients: SolAddress[];
  buybackFeeRecipients: SolAddress[];
  creatorFeeConfigurable: boolean;
  /** What a coin made now starts with (left out of hand-made test globals). */
  launch?: LaunchTerms;
}

/** The curve create_v2 makes, and whether pump.fun takes new coins. */
export interface LaunchTerms {
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  createV2Enabled: boolean;
}

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: SolAddress;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** The default key on SOL curves created before quote mints existed. */
  quoteMint: SolAddress;
  creatorFeeBps: bigint;
}

export interface AmmGlobalConfig {
  lpFeeBasisPoints: bigint;
  protocolFeeBasisPoints: bigint;
  coinCreatorFeeBasisPoints: bigint;
  /** Where v1 pool trades may send the protocol fee (unset slots left out). */
  protocolFeeRecipients: SolAddress[];
  /** The same, for mayhem pools. */
  reservedFeeRecipients: SolAddress[];
  buybackFeeRecipients: SolAddress[];
  creatorFeeConfigurable: boolean;
}

export interface AmmPool {
  creator: SolAddress;
  baseMint: SolAddress;
  quoteMint: SolAddress;
  poolBaseTokenAccount: SolAddress;
  poolQuoteTokenAccount: SolAddress;
  coinCreator: SolAddress;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** Signed: added to the quote vault to price trades. */
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
}

function fees(r: Reader): Fees {
  return { lpFeeBps: r.u64(), protocolFeeBps: r.u64(), creatorFeeBps: r.u64() };
}

function tiers(r: Reader): FeeTier[] {
  const n = r.u32();
  if (n > 64) throw new Error('bad fee tiers');
  return Array.from({ length: n }, () => ({ threshold: r.u128(), fees: fees(r) }));
}

const keys = (r: Reader, n: number) => Array.from({ length: n }, () => r.pubkey());
const listed = (list: SolAddress[]) => list.filter((k) => k !== DEFAULT_KEY);

export function decodeGlobal(data: Uint8Array): PumpGlobal | null {
  if (!hasDiscriminator(data, DISC.global)) return null;
  const r = new Reader(data, 8);
  r.skip(1 + 32);
  const feeRecipient = r.pubkey();
  const initialVirtualTokenReserves = r.u64();
  const initialVirtualSolReserves = r.u64();
  const initialRealTokenReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const feeBasisPoints = r.u64();
  r.skip(32 + 1);
  const poolMigrationFee = r.u64();
  const creatorFeeBasisPoints = r.u64();
  const feeRecipients = keys(r, 7);
  r.skip(32 + 32);
  const createV2Enabled = r.bool();
  r.skip(32);
  const reservedFeeRecipient = r.pubkey();
  r.skip(1);
  const reservedFeeRecipients = keys(r, 7);
  r.skip(1);
  const buybackFeeRecipients = keys(r, 8);
  r.skip(8 + 8 + 32);
  const creatorFeeConfigurable = r.bool();
  return {
    poolMigrationFee,
    feeBasisPoints,
    creatorFeeBasisPoints,
    feeRecipients: listed([feeRecipient, ...feeRecipients]),
    reservedFeeRecipients: listed([reservedFeeRecipient, ...reservedFeeRecipients]),
    buybackFeeRecipients,
    creatorFeeConfigurable,
    launch: {
      initialVirtualTokenReserves,
      initialVirtualSolReserves,
      initialRealTokenReserves,
      tokenTotalSupply,
      createV2Enabled,
    },
  };
}

export function decodeBondingCurve(data: Uint8Array): BondingCurve | null {
  if (!hasDiscriminator(data, DISC.bondingCurve)) return null;
  const r = new Reader(data, 8);
  const virtualTokenReserves = r.u64();
  const virtualQuoteReserves = r.u64();
  const realTokenReserves = r.u64();
  const realQuoteReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const complete = r.bool();
  const creator = r.pubkey();
  const isMayhemMode = r.bool();
  const isCashbackCoin = r.bool();
  const quoteMint = r.pubkey();
  const creatorFeeBps = r.u64();
  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    creatorFeeBps,
  };
}

export function decodeFeeConfig(data: Uint8Array): FeeConfig | null {
  if (!hasDiscriminator(data, DISC.feeConfig)) return null;
  const r = new Reader(data, 8 + 1 + 32);
  const flatFees = fees(r);
  const feeTiers = tiers(r);
  const stableFeeTiers = tiers(r);
  const exoticFlatFees = fees(r);
  return feeTiers.length > 0 ? { flatFees, feeTiers, stableFeeTiers, exoticFlatFees } : null;
}

export function decodeAmmGlobalConfig(data: Uint8Array): AmmGlobalConfig | null {
  if (!hasDiscriminator(data, DISC.globalConfig)) return null;
  const r = new Reader(data, 8 + 32);
  const lpFeeBasisPoints = r.u64();
  const protocolFeeBasisPoints = r.u64();
  r.skip(1);
  const protocolFeeRecipients = keys(r, 8);
  const coinCreatorFeeBasisPoints = r.u64();
  r.skip(32 + 32);
  const reservedFeeRecipient = r.pubkey();
  r.skip(1);
  const reservedFeeRecipients = keys(r, 7);
  r.skip(1);
  const buybackFeeRecipients = keys(r, 8);
  r.skip(8 + 32 + 1);
  const creatorFeeConfigurable = r.bool();
  return {
    lpFeeBasisPoints,
    protocolFeeBasisPoints,
    coinCreatorFeeBasisPoints,
    protocolFeeRecipients: listed(protocolFeeRecipients),
    reservedFeeRecipients: listed([reservedFeeRecipient, ...reservedFeeRecipients]),
    buybackFeeRecipients,
    creatorFeeConfigurable,
  };
}

export function decodePool(data: Uint8Array): AmmPool | null {
  if (!hasDiscriminator(data, DISC.pool)) return null;
  const r = new Reader(data, 8 + 1 + 2);
  const creator = r.pubkey();
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  r.skip(32);
  const poolBaseTokenAccount = r.pubkey();
  const poolQuoteTokenAccount = r.pubkey();
  r.skip(8);
  const coinCreator = r.pubkey();
  const isMayhemMode = r.bool();
  const isCashbackCoin = r.bool();
  const virtualQuoteReserves = r.i128();
  const creatorFeeBps = r.u64();
  r.skip(2);
  const protocolFees = r.u64();
  const creatorFees = r.u64();
  return {
    creator,
    baseMint,
    quoteMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    coinCreator,
    isMayhemMode,
    isCashbackCoin,
    virtualQuoteReserves,
    creatorFeeBps,
    protocolFees,
    creatorFees,
  };
}

// ── venues ──────────────────────────────────────────────────────────────────

/** What a coin trades against: SOL (as WSOL) or a token, with its token program. */
export interface QuoteAsset {
  mint: SolAddress;
  program: SolAddress;
}

export const SOL_QUOTE: QuoteAsset = { mint: WSOL_MINT, program: TOKEN_PROGRAM };
export const isSolQuote = (q: QuoteAsset) => q.mint === WSOL_MINT;
/** A curve's quote mint: SOL curves store the default key (older coins) or WSOL. */
export const curveQuoteMint = (c: BondingCurve): SolAddress =>
  c.quoteMint === DEFAULT_KEY ? WSOL_MINT : c.quoteMint;

/** A coin still on its bonding curve. */
export interface CurveVenue {
  kind: 'curve';
  mint: SolAddress;
  tokenProgram: SolAddress;
  quote: QuoteAsset;
  curve: BondingCurve;
  /** The curve's own token balance: prices a buy that runs past the curve. */
  curveTokenBalance: bigint;
  global: PumpGlobal;
  feeConfig: FeeConfig;
  mintSupply: bigint;
}

/** A coin on its canonical PumpSwap pool (after migration). */
export interface PoolVenue {
  kind: 'pool';
  mint: SolAddress;
  tokenProgram: SolAddress;
  quote: QuoteAsset;
  poolAddress: SolAddress;
  pool: AmmPool;
  baseReserve: bigint;
  /** The quote vault balance, before virtual reserves. */
  quoteReserve: bigint;
  globalConfig: AmmGlobalConfig;
  feeConfig: FeeConfig;
  mintSupply: bigint;
}

export type PumpVenue = CurveVenue | PoolVenue;

export function venueLabel(v: PumpVenue): string {
  return v.kind === 'curve' ? 'pump.fun' : 'PumpSwap';
}

const isCashback = (v: PumpVenue) =>
  v.kind === 'curve' ? v.curve.isCashbackCoin : v.pool.isCashbackCoin;
const isMayhem = (v: PumpVenue) =>
  v.kind === 'curve' ? v.curve.isMayhemMode : v.pool.isMayhemMode;

/** The Token-2022 native mint: SOL-like to the fee program, never a curve's quote. */
const NATIVE_MINT_2022 = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';
const isSolLike = (mint: SolAddress) =>
  mint === DEFAULT_KEY || mint === WSOL_MINT || mint === NATIVE_MINT_2022;

function feeTier(tiersList: readonly FeeTier[], marketCap: bigint): Fees {
  const first = tiersList[0];
  if (!first) throw new Error('no fee tiers');
  if (marketCap < first.threshold) return first.fees;
  // The highest tier the market cap has reached.
  const reached = tiersList.filter((t) => marketCap >= t.threshold);
  return (reached[reached.length - 1] ?? first).fees;
}

const isZeroFees = (f: Fees) =>
  f.lpFeeBps === 0n && f.protocolFeeBps === 0n && f.creatorFeeBps === 0n;

/** pump-fees `fees_for_quote_mint` for a canonical pump curve or pool. */
function pumpSchedule(config: FeeConfig, quoteMint: SolAddress, marketCap: bigint): Fees {
  if (isSolLike(quoteMint)) return feeTier(config.feeTiers, marketCap);
  if (quoteMint === USDC_MINT)
    return feeTier(
      config.stableFeeTiers.length > 0 ? config.stableFeeTiers : config.feeTiers,
      marketCap,
    );
  return isZeroFees(config.exoticFlatFees) ? config.flatFees : config.exoticFlatFees;
}

const ceilFee = (amount: bigint, bps: bigint) => (amount * bps + BPS - 1n) / BPS;

/** Which fees a trade charges: all of them, except on the hops of a multi-hop route. */
export interface HopFees {
  protocol: boolean;
  creator: boolean;
  lp: boolean;
}

export const ALL_FEES: HopFees = { protocol: true, creator: true, lp: true };

/**
 * pump-amm's `multi_hop_swap` charges each fee once per route: the protocol fee on the hop
 * trading the user's currency, the creator fee (and a pool's LP fee) on the far coin's hop.
 * `i` counts hops in trade order; a lone hop charges everything.
 */
export function hopFees(side: Side, i: number, n: number, isPool: boolean): HopFees {
  const first = i === 0;
  const last = i === n - 1;
  const [protocol, target] = side === 'buy' ? [first, last] : [last, first];
  return { protocol, creator: target, lp: target && isPool };
}

interface CurveRates {
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

function curveRates(v: CurveVenue, mask: HopFees): CurveRates {
  const c = v.curve;
  const supply = c.isMayhemMode ? v.mintSupply : ONE_BILLION_SUPPLY;
  const marketCap = (c.virtualQuoteReserves * supply) / c.virtualTokenReserves;
  const schedule = pumpSchedule(v.feeConfig, c.quoteMint, marketCap);
  const creatorRate =
    v.global.creatorFeeConfigurable && c.creatorFeeBps > 0n
      ? c.creatorFeeBps
      : schedule.creatorFeeBps;
  return {
    protocolFeeBps: mask.protocol ? schedule.protocolFeeBps : 0n,
    creatorFeeBps: mask.creator && c.creator !== DEFAULT_KEY ? creatorRate : 0n,
  };
}

const curveFees = (amount: bigint, r: CurveRates) =>
  ceilFee(amount, r.protocolFeeBps) + ceilFee(amount, r.creatorFeeBps);

/** pump `exact_quote_in_fees`: what a budget leaves for the curve once fees are taken. */
function curveNetOf(budget: bigint, r: CurveRates): bigint {
  const total = r.protocolFeeBps + r.creatorFeeBps;
  let net = total === 0n ? budget : (budget * BPS) / (total + BPS);
  const cost = net + curveFees(net, r);
  if (cost > budget) net -= cost - budget;
  return net;
}

/** Why a curve takes no trades right now, or null when it does. */
export function curveIdle(c: BondingCurve): string | null {
  return c.complete || c.virtualTokenReserves === 0n
    ? 'The pump.fun curve is complete. Trading opens on PumpSwap once it migrates.'
    : null;
}

/**
 * Tokens a curve buy gives for `amountIn` of its quote. With `synthetic` (v3 buys and
 * route hops), the part of a buy past the curve's end buys from the pool its migration
 * opens. Otherwise, and always on mayhem coins, such a buy fails: it is quoted 0.
 */
export function curveBuyQuote(
  v: CurveVenue,
  amountIn: bigint,
  mask: HopFees = ALL_FEES,
  synthetic = true,
): bigint {
  const c = v.curve;
  if (amountIn <= 0n || curveIdle(c)) return 0n;
  const r = curveRates(v, mask);
  const net = curveNetOf(amountIn, r);
  if (net <= 1n) return 0n;
  const tokens = ((net - 1n) * c.virtualTokenReserves) / (c.virtualQuoteReserves + net - 1n);
  const remaining = c.realTokenReserves;
  if (tokens <= remaining) return tokens;
  if (!synthetic || c.isMayhemMode) return 0n;

  // Synthetic migration: the rest of the budget buys from the pool the migration will open.
  const curveNet = (remaining * c.virtualQuoteReserves) / (c.virtualTokenReserves - remaining) + 1n;
  const budgetLeft = amountIn - (curveNet + curveFees(curveNet, r));
  if (budgetLeft <= 0n) return remaining;
  const total = r.protocolFeeBps + r.creatorFeeBps;
  const afterFees = total === 0n ? budgetLeft : (budgetLeft * BPS) / (total + BPS);
  if (afterFees < 2n) return remaining;
  const legNet = curveNetOf(budgetLeft, r);
  const poolBase = v.curveTokenBalance - remaining;
  // The migration fee comes out of a SOL curve's SOL; a token-quoted curve pays none.
  const migrationFee = isSolQuote(v.quote) ? v.global.poolMigrationFee : 0n;
  const poolQuote = c.realQuoteReserves + curveNet - migrationFee;
  if (poolBase <= 0n || poolQuote <= 0n) return remaining;
  return remaining + ((legNet - 1n) * poolBase) / (poolQuote + legNet - 1n);
}

/** What a curve sell pays in its quote for `tokens`, after fees. */
export function curveSellQuote(v: CurveVenue, tokens: bigint, mask: HopFees = ALL_FEES): bigint {
  const c = v.curve;
  if (tokens <= 0n || curveIdle(c)) return 0n;
  const gross = (tokens * c.virtualQuoteReserves) / (c.virtualTokenReserves + tokens);
  const out = gross - curveFees(gross, curveRates(v, mask));
  return out > 0n ? out : 0n;
}

function poolFees(v: PoolVenue, mask: HopFees): Fees {
  const p = v.pool;
  const effQuote = v.quoteReserve + p.virtualQuoteReserves;
  const isPumpPool = p.creator === poolAuthority(v.mint);
  const supply = p.isMayhemMode ? ONE_BILLION_SUPPLY : v.mintSupply;
  const marketCap = v.baseReserve > 0n ? (effQuote * supply) / v.baseReserve : 0n;
  const schedule = isPumpPool
    ? pumpSchedule(v.feeConfig, p.quoteMint, marketCap)
    : v.feeConfig.flatFees;
  const creatorFeeBps =
    v.globalConfig.creatorFeeConfigurable && p.creatorFeeBps > 0n
      ? p.creatorFeeBps
      : schedule.creatorFeeBps;
  return {
    lpFeeBps: mask.lp ? schedule.lpFeeBps : 0n,
    protocolFeeBps: mask.protocol ? schedule.protocolFeeBps : 0n,
    creatorFeeBps: mask.creator && p.coinCreator !== DEFAULT_KEY ? creatorFeeBps : 0n,
  };
}

/** Tokens a pool buy gives for `amountIn` of its quote. */
export function poolBuyQuote(v: PoolVenue, amountIn: bigint, mask: HopFees = ALL_FEES): bigint {
  const effQuote = v.quoteReserve + v.pool.virtualQuoteReserves;
  if (amountIn <= 0n || v.baseReserve === 0n || effQuote <= 0n) return 0n;
  const f = poolFees(v, mask);
  const total = f.lpFeeBps + f.protocolFeeBps + f.creatorFeeBps;
  let net = (amountIn * BPS) / (BPS + total);
  const cost =
    net + ceilFee(net, f.lpFeeBps) + ceilFee(net, f.protocolFeeBps) + ceilFee(net, f.creatorFeeBps);
  if (cost > amountIn) net -= cost - amountIn;
  if (net <= 1n) return 0n;
  return (v.baseReserve * (net - 1n)) / (effQuote + net - 1n);
}

/** What a pool sell pays in its quote for `tokens`, after fees; 0 when the vault cannot. */
export function poolSellQuote(v: PoolVenue, tokens: bigint, mask: HopFees = ALL_FEES): bigint {
  const p = v.pool;
  const effQuote = v.quoteReserve + p.virtualQuoteReserves;
  if (tokens <= 0n || effQuote <= 0n) return 0n;
  const gross = (effQuote * tokens) / (v.baseReserve + tokens);
  const f = poolFees(v, mask);
  const withoutLp = gross - ceilFee(gross, f.lpFeeBps);
  // Sells are paid from the vault net of the fees v2 trades left in it.
  if (v.quoteReserve - p.protocolFees - p.creatorFees < withoutLp) return 0n;
  const out = withoutLp - ceilFee(gross, f.protocolFeeBps) - ceilFee(gross, f.creatorFeeBps);
  return out > 0n ? out : 0n;
}

/** Quote units per raw coin unit at the current price, as a float (for impact and USD). */
export function spotPrice(v: PumpVenue): number {
  if (v.kind === 'curve') {
    const c = v.curve;
    return c.virtualTokenReserves > 0n
      ? Number(c.virtualQuoteReserves) / Number(c.virtualTokenReserves)
      : 0;
  }
  const effQuote = v.quoteReserve + v.pool.virtualQuoteReserves;
  return v.baseReserve > 0n ? Number(effQuote) / Number(v.baseReserve) : 0;
}

// ── routes ──────────────────────────────────────────────────────────────────

/**
 * How a coin is reached from what the user pays with: SOL, or the token at the bottom of
 * its quote chain. One hop trades on the coin's own curve or pool; more go through
 * PumpSwap's `multi_hop_swap`, which prices each hop like its direct trade.
 */
export interface PumpRoute {
  pay: QuoteAsset;
  /** From the pay currency up to the coin: each hop is quoted in the previous hop's coin. */
  hops: PumpVenue[];
}

/**
 * The longest route that fits a legacy transaction (1232 bytes): a 2-hop SOL buy takes
 * about 1130, a 3-hop one 1240–1265.
 */
export const MAX_HOPS = 2;

/** The trade a route takes. Cashback coins and mayhem pools refuse the newer versions. */
export type TradeVariant = 'curve-v3' | 'curve-v2' | 'pool-v2' | 'pool-v1' | 'multi-hop';

export const routeCoin = (r: PumpRoute): PumpVenue => r.hops[r.hops.length - 1] as PumpVenue;

const inTradeOrder = (r: PumpRoute, side: Side) =>
  side === 'buy' ? r.hops : [...r.hops].reverse();

export function routeVariant(r: PumpRoute): TradeVariant {
  if (r.hops.length > 1) return 'multi-hop';
  const v = routeCoin(r);
  if (v.kind === 'curve') return v.curve.isCashbackCoin ? 'curve-v2' : 'curve-v3';
  return v.pool.isCashbackCoin || v.pool.isMayhemMode ? 'pool-v1' : 'pool-v2';
}

/**
 * Whether a route's hops chain from its pay currency, and (past one hop) whether
 * `multi_hop_swap` takes them: canonical pools, no mayhem coins, and a cashback coin only
 * on the hop next to the user's currency.
 */
export function routeOk(r: PumpRoute): boolean {
  if (r.hops.length === 0 || r.hops.length > MAX_HOPS) return false;
  let quote = r.pay.mint;
  for (const v of r.hops) {
    if (v.quote.mint !== quote) return false;
    quote = v.mint;
  }
  if (r.hops.length === 1) return true;
  return r.hops.every(
    (v, i) =>
      !isMayhem(v) &&
      (i === 0 || !isCashback(v)) &&
      (v.kind === 'curve'
        ? !curveIdle(v.curve)
        : v.pool.creator === poolAuthority(v.mint) &&
          v.poolAddress === canonicalPoolAddress(v.mint, v.quote.mint)),
  );
}

/**
 * The route a coin trades by, from its quote chain: `chain[0]` the coin's own venue, each
 * next one the venue of the one before's quote coin. The longest the programs allow, so the
 * user pays with SOL or a token they likely hold rather than an intermediate coin.
 */
export function pickRoute(chain: readonly PumpVenue[]): PumpRoute | null {
  for (let d = Math.min(chain.length, MAX_HOPS); d >= 1; d--) {
    const hops = chain.slice(0, d).reverse();
    const route: PumpRoute = { pay: (hops[0] as PumpVenue).quote, hops };
    if (routeOk(route)) return route;
  }
  return null;
}

/** What `amountIn` of the pay currency buys of the coin. */
export function routeBuyQuote(r: PumpRoute, amountIn: bigint): bigint {
  const synthetic = routeVariant(r) !== 'curve-v2';
  const n = r.hops.length;
  let amount = amountIn;
  for (const [i, v] of r.hops.entries()) {
    const mask = hopFees('buy', i, n, v.kind === 'pool');
    amount =
      v.kind === 'curve'
        ? curveBuyQuote(v, amount, mask, synthetic)
        : poolBuyQuote(v, amount, mask);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

/** What selling `tokens` of the coin pays in the pay currency. */
export function routeSellQuote(r: PumpRoute, tokens: bigint): bigint {
  const hops = inTradeOrder(r, 'sell');
  let amount = tokens;
  for (const [i, v] of hops.entries()) {
    const mask = hopFees('sell', i, hops.length, v.kind === 'pool');
    amount = v.kind === 'curve' ? curveSellQuote(v, amount, mask) : poolSellQuote(v, amount, mask);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

/** Pay units per raw coin unit at the current prices. */
export function routeSpotPrice(r: PumpRoute): number {
  return r.hops.reduce((price, v) => price * spotPrice(v), 1);
}

export function routeIdle(r: PumpRoute): string | null {
  for (const v of r.hops) {
    const why = v.kind === 'curve' ? curveIdle(v.curve) : null;
    if (why) return why;
  }
  return null;
}

// ── instructions ────────────────────────────────────────────────────────────

/** Accounts a trade pays fees into, beyond what the programs derive themselves. */
export interface TradeRecipients {
  /** A listed buyback wallet (the trade names it, or its account in the pay currency). */
  buyback: SolAddress;
  /** v2 curve and v1 pool trades: the protocol fee recipient, from the venue's own list. */
  fee?: SolAddress;
}

const ata = associatedTokenAddress;

/** Where a v2 curve or v1 pool trade on `v` may send the protocol fee. */
export function feeRecipients(v: PumpVenue): SolAddress[] {
  if (v.kind === 'curve')
    return v.curve.isMayhemMode ? v.global.reservedFeeRecipients : v.global.feeRecipients;
  return v.pool.isMayhemMode
    ? v.globalConfig.reservedFeeRecipients
    : v.globalConfig.protocolFeeRecipients;
}

/**
 * Whether the trade pays the buyback slice into an account of the listed wallet (token
 * quotes, routes) rather than to the wallet itself. Such an account must exist, so the
 * trade creates it when missing, as pump.fun's own client does.
 */
export const buybackPaysAccount = (r: PumpRoute) => !isSolQuote(r.pay) || r.hops.length > 1;

/** Fee accounts for a trade on `r`, or null when pump.fun lists none Nesty knows. */
export function pickRecipients(r: PumpRoute): TradeRecipients | null {
  const v = routeCoin(r);
  const onChain =
    v.kind === 'curve' ? v.global.buybackFeeRecipients : v.globalConfig.buybackFeeRecipients;
  const ok = BUYBACK_FEE_RECIPIENTS.filter((w) => onChain.includes(w));
  // Accounts of the first listed wallet are the ones pump.fun keeps open; a wallet itself
  // takes SOL at any of them.
  const buyback = buybackPaysAccount(r) ? ok[0] : ok[Math.floor(Math.random() * ok.length)];
  if (!buyback) return null;
  const variant = routeVariant(r);
  if (variant !== 'curve-v2' && variant !== 'pool-v1') return { buyback };
  const list = feeRecipients(v);
  const fee = list[Math.floor(Math.random() * list.length)];
  return fee ? { buyback, fee } : null;
}

/** The 17 accounts of a v3 curve trade. `buyback`: the wallet on SOL, else its quote account. */
function curveV3Accounts(v: CurveVenue, user: SolAddress, buyback: SolAddress): AccountMeta[] {
  const q = v.quote;
  const curve = bondingCurveAddress(v.mint);
  return [
    meta(PUMP_GLOBAL),
    meta(v.mint),
    meta(q.mint),
    meta(v.tokenProgram),
    meta(q.program),
    meta(curve, true),
    meta(ata(curve, v.mint, v.tokenProgram), true),
    meta(ata(curve, q.mint, q.program), true),
    meta(user, true, true),
    meta(ata(user, v.mint, v.tokenProgram), true),
    meta(ata(user, q.mint, q.program), true),
    meta(pumpVolumeAccumulator(user), true),
    meta(PUMP_FEE_CONFIG),
    meta(buyback, true),
    meta(SYSTEM_PROGRAM),
    meta(pumpEventAuthority()),
    meta(PUMP_PROGRAM),
  ];
}

/** The accounts of a v2 curve trade (27 for a buy, 26 for a sell). */
function curveV2Accounts(
  v: CurveVenue,
  side: Side,
  user: SolAddress,
  fee: SolAddress,
  buyback: SolAddress,
): AccountMeta[] {
  const q = v.quote;
  const curve = bondingCurveAddress(v.mint);
  const vault = creatorVaultAddress(v.curve.creator);
  const accumulator = pumpVolumeAccumulator(user);
  return [
    meta(PUMP_GLOBAL),
    meta(v.mint),
    meta(q.mint),
    meta(v.tokenProgram),
    meta(q.program),
    meta(ATA_PROGRAM),
    meta(fee, true),
    meta(ata(fee, q.mint, q.program), true),
    meta(buyback, true),
    meta(ata(buyback, q.mint, q.program), true),
    meta(curve, true),
    meta(ata(curve, v.mint, v.tokenProgram), true),
    meta(ata(curve, q.mint, q.program), true),
    meta(user, true, true),
    meta(ata(user, v.mint, v.tokenProgram), true),
    meta(ata(user, q.mint, q.program), true),
    meta(vault, true),
    meta(ata(vault, q.mint, q.program), true),
    meta(sharingConfigAddress(v.mint)),
    ...(side === 'buy' ? [meta(pumpGlobalVolumeAccumulator())] : []),
    meta(accumulator, true),
    meta(ata(accumulator, q.mint, q.program), true),
    meta(PUMP_FEE_CONFIG),
    meta(PUMP_FEES_PROGRAM),
    meta(SYSTEM_PROGRAM),
    meta(pumpEventAuthority()),
    meta(PUMP_PROGRAM),
  ];
}

/** The 17 accounts of a v2 trade on the coin's canonical pool. */
function poolV2Accounts(v: PoolVenue, user: SolAddress, buyback: SolAddress): AccountMeta[] {
  const q = v.quote;
  return [
    meta(canonicalPoolAddress(v.mint, q.mint), true),
    meta(user, true, true),
    meta(AMM_GLOBAL_CONFIG),
    meta(v.mint),
    meta(q.mint),
    meta(ata(user, v.mint, v.tokenProgram), true),
    meta(ata(user, q.mint, q.program), true),
    // The pool's own vaults: the program checks them against the pool.
    meta(v.pool.poolBaseTokenAccount, true),
    meta(v.pool.poolQuoteTokenAccount, true),
    meta(v.tokenProgram),
    meta(q.program),
    meta(SYSTEM_PROGRAM),
    meta(ammVolumeAccumulator(user), true),
    meta(AMM_FEE_CONFIG),
    meta(ata(buyback, q.mint, q.program), true),
    meta(ammEventAuthority()),
    meta(PUMP_AMM_PROGRAM),
  ];
}

/**
 * The accounts of a v1 pool trade: 23 named ones for a buy (21 for a sell), then the
 * cashback accounts, the pool's v2 account when it has a coin creator, and the buyback pair.
 */
function poolV1Accounts(
  v: PoolVenue,
  side: Side,
  user: SolAddress,
  fee: SolAddress,
  buyback: SolAddress,
): AccountMeta[] {
  const q = v.quote;
  const p = v.pool;
  const authority = ammCreatorVaultAuthority(p.coinCreator);
  const accumulator = ammVolumeAccumulator(user);
  const accumulatorQuote = meta(ata(accumulator, q.mint, q.program), true);
  return [
    meta(canonicalPoolAddress(v.mint, q.mint), true),
    meta(user, true, true),
    meta(AMM_GLOBAL_CONFIG),
    meta(v.mint),
    meta(q.mint),
    meta(ata(user, v.mint, v.tokenProgram), true),
    meta(ata(user, q.mint, q.program), true),
    meta(p.poolBaseTokenAccount, true),
    meta(p.poolQuoteTokenAccount, true),
    meta(fee),
    meta(ata(fee, q.mint, q.program), true),
    meta(v.tokenProgram),
    meta(q.program),
    meta(SYSTEM_PROGRAM),
    meta(ATA_PROGRAM),
    meta(ammEventAuthority()),
    meta(PUMP_AMM_PROGRAM),
    meta(ata(authority, q.mint, q.program), true),
    meta(authority),
    ...(side === 'buy' ? [meta(ammGlobalVolumeAccumulator()), meta(accumulator, true)] : []),
    meta(AMM_FEE_CONFIG),
    meta(PUMP_FEES_PROGRAM),
    ...(p.isCashbackCoin
      ? side === 'buy'
        ? [accumulatorQuote]
        : [accumulatorQuote, meta(accumulator, true)]
      : []),
    ...(p.coinCreator !== DEFAULT_KEY ? [meta(poolV2Address(v.mint))] : []),
    meta(buyback),
    meta(ata(buyback, q.mint, q.program), true),
  ];
}

/** One hop of a route: its two mints, the curve or canonical pool, and that venue's vaults. */
function hopAccounts(v: PumpVenue): AccountMeta[] {
  const venue =
    v.kind === 'pool' ? canonicalPoolAddress(v.mint, v.quote.mint) : bondingCurveAddress(v.mint);
  return [
    meta(v.mint),
    meta(v.quote.mint),
    meta(venue, true),
    meta(ata(venue, v.mint, v.tokenProgram), true),
    meta(ata(venue, v.quote.mint, v.quote.program), true),
  ];
}

/** The 16 fixed accounts of a `multi_hop_swap`, then 5 per hop in trade order. */
function multiHopAccounts(
  r: PumpRoute,
  side: Side,
  user: SolAddress,
  buyback: SolAddress,
): AccountMeta[] {
  const coin = routeCoin(r);
  const held = { mint: coin.mint, program: coin.tokenProgram };
  const [input, output] = side === 'buy' ? [r.pay, held] : [held, r.pay];
  return [
    meta(user, true, true),
    meta(ata(user, input.mint, input.program), true),
    meta(ata(user, output.mint, output.program), true),
    meta(AMM_GLOBAL_CONFIG),
    meta(AMM_FEE_CONFIG),
    meta(ammVolumeAccumulator(user), true),
    meta(ata(buyback, r.pay.mint, r.pay.program), true),
    meta(TOKEN_PROGRAM),
    meta(TOKEN_2022_PROGRAM),
    meta(SYSTEM_PROGRAM),
    meta(ammEventAuthority()),
    meta(PUMP_AMM_PROGRAM),
    meta(PUMP_PROGRAM),
    meta(PUMP_GLOBAL),
    meta(PUMP_FEE_CONFIG),
    meta(pumpEventAuthority()),
    ...inTradeOrder(r, side).flatMap(hopAccounts),
  ];
}

/** Discriminator and trailing flag byte of each trade: amount and minimum sit between. */
export const TRADE_DATA: Record<
  TradeVariant,
  Record<Side, { disc: readonly number[]; flag?: number }>
> = {
  // partial_fill = false: a buy the curve cannot fill fails instead.
  'curve-v3': { buy: { disc: IX.buyExactQuoteInV3, flag: 0 }, sell: { disc: IX.sellV3 } },
  'curve-v2': { buy: { disc: IX.buyExactQuoteInV2, flag: 0 }, sell: { disc: IX.sellV2 } },
  'pool-v2': { buy: { disc: IX.buyExactQuoteInV2 }, sell: { disc: IX.sellV2 } },
  // track_volume = true, as pump.fun's client sends it: cashback accrues on tracked volume.
  'pool-v1': { buy: { disc: IX.ammBuyExactQuoteIn, flag: 1 }, sell: { disc: IX.ammSell } },
  'multi-hop': { buy: { disc: IX.multiHopSwap }, sell: { disc: IX.multiHopSwap } },
};

export const tradeProgram = (variant: TradeVariant) =>
  variant === 'curve-v3' || variant === 'curve-v2' ? PUMP_PROGRAM : PUMP_AMM_PROGRAM;

/** The accounts of the trade instruction a route takes, for `user` and these recipients. */
export function tradeAccounts(
  r: PumpRoute,
  side: Side,
  user: SolAddress,
  rec: TradeRecipients,
): AccountMeta[] {
  const v = routeCoin(r);
  const variant = routeVariant(r);
  if (variant === 'multi-hop') return multiHopAccounts(r, side, user, rec.buyback);
  if (v.kind === 'curve') {
    if (variant === 'curve-v2') return curveV2Accounts(v, side, user, rec.fee ?? '', rec.buyback);
    const q = v.quote;
    return curveV3Accounts(
      v,
      user,
      isSolQuote(q) ? rec.buyback : ata(rec.buyback, q.mint, q.program),
    );
  }
  return variant === 'pool-v1'
    ? poolV1Accounts(v, side, user, rec.fee ?? '', rec.buyback)
    : poolV2Accounts(v, user, rec.buyback);
}

/**
 * The recipients a trade instruction names, read back from its accounts (buyback accounts
 * resolved to their listed wallet). Null when they are not where the route puts them, or
 * the buyback is not a listed wallet's.
 */
export function readRecipients(r: PumpRoute, keys: readonly AccountMeta[]): TradeRecipients | null {
  const pay = r.pay;
  const at = (i: number) => keys[i]?.pubkey ?? '';
  const wallet = (key: string) => (BUYBACK_FEE_RECIPIENTS.includes(key) ? key : null);
  const owner = (account: string) =>
    BUYBACK_FEE_RECIPIENTS.find((w) => ata(w, pay.mint, pay.program) === account) ?? null;
  let buyback: SolAddress | null;
  let fee: SolAddress | undefined;
  switch (routeVariant(r)) {
    case 'curve-v3':
      buyback = isSolQuote(pay) ? wallet(at(13)) : owner(at(13));
      break;
    case 'curve-v2':
      buyback = wallet(at(8));
      fee = at(6);
      break;
    case 'pool-v2':
      buyback = owner(at(14));
      break;
    case 'pool-v1':
      buyback = wallet(at(keys.length - 2));
      fee = at(9);
      break;
    case 'multi-hop':
      buyback = owner(at(6));
      break;
  }
  if (!buyback) return null;
  return fee === undefined ? { buyback } : { buyback, fee };
}

export interface TradeIxs {
  instructions: Instruction[];
  /** What the wallet puts into the trade, in the pay currency (buys). */
  spend: bigint;
}

function tradeInstruction(
  r: PumpRoute,
  side: Side,
  user: SolAddress,
  amount: bigint,
  minOut: bigint,
  rec: TradeRecipients,
): Instruction {
  const variant = routeVariant(r);
  const { disc, flag } = TRADE_DATA[variant][side];
  return {
    programId: tradeProgram(variant),
    keys: tradeAccounts(r, side, user, rec),
    data: concat(disc, u64(amount), u64(minOut), flag === undefined ? [] : [flag]),
  };
}

/** Creates the buyback wallet's account in the pay currency when the trade pays into it. */
function buybackAccount(r: PumpRoute, user: SolAddress, rec: TradeRecipients): Instruction[] {
  return buybackPaysAccount(r)
    ? [createAtaIdempotent(rec.buyback, r.pay.mint, r.pay.program, user)]
    : [];
}

/**
 * Whether a SOL route needs the wallet's WSOL account: pools trade WSOL, and a route reads
 * the account even where a curve moves SOL itself.
 */
const usesWsol = (r: PumpRoute, end: PumpVenue) =>
  isSolQuote(r.pay) && (end.kind === 'pool' || r.hops.length > 1);

/** Buy for exactly `amountIn` of the pay currency (fees included), receiving at least `minOut`. */
export function buyInstructions(
  r: PumpRoute,
  user: SolAddress,
  amountIn: bigint,
  minOut: bigint,
  rec: TradeRecipients,
): TradeIxs {
  const coin = routeCoin(r);
  const first = r.hops[0] as PumpVenue;
  const ownAta = createAtaIdempotent(user, coin.mint, coin.tokenProgram);
  const trade = tradeInstruction(r, 'buy', user, amountIn, minOut, rec);
  const wsol = wsolAccount(user);
  // SOL into a pool is wrapped first; a curve takes it as lamports.
  const wraps = isSolQuote(r.pay) && first.kind === 'pool';
  const opens = usesWsol(r, first);
  return {
    spend: amountIn,
    instructions: [
      ...(opens ? [createAtaIdempotent(user, WSOL_MINT, TOKEN_PROGRAM)] : []),
      ...(wraps ? [transfer(user, wsol, amountIn), syncNative(wsol)] : []),
      ownAta,
      ...buybackAccount(r, user, rec),
      trade,
      ...(opens ? [closeAccount(wsol, user)] : []),
    ],
  };
}

/** Sell exactly `tokens`, receiving at least `minOut` of the pay currency. */
export function sellInstructions(
  r: PumpRoute,
  user: SolAddress,
  tokens: bigint,
  minOut: bigint,
  rec: TradeRecipients,
): TradeIxs {
  const trade = tradeInstruction(r, 'sell', user, tokens, minOut, rec);
  const pay = r.pay;
  if (!isSolQuote(pay)) {
    return {
      spend: 0n,
      instructions: [
        createAtaIdempotent(user, pay.mint, pay.program),
        ...buybackAccount(r, user, rec),
        trade,
      ],
    };
  }
  // A pool pays WSOL, unwrapped after; a curve pays lamports.
  const opens = usesWsol(r, r.hops[0] as PumpVenue);
  const wsol = wsolAccount(user);
  return {
    spend: 0n,
    instructions: [
      ...(opens ? [createAtaIdempotent(user, WSOL_MINT, TOKEN_PROGRAM)] : []),
      ...buybackAccount(r, user, rec),
      trade,
      ...(opens ? [closeAccount(wsol, user)] : []),
    ],
  };
}

export function isTokenProgram(owner: SolAddress): boolean {
  return owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM;
}
