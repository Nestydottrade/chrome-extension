import { describe, expect, it } from 'vitest';
import { createInstructions, devBuyQuote, freshRoute } from '../src/background/create/pump';
import {
  DEFAULT_KEY,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
  findProgramAddress,
  seed,
} from '../src/background/solana/address';
import {
  ALL_FEES,
  BUYBACK_FEE_RECIPIENTS,
  MAX_HOPS,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SOL_QUOTE,
  buyInstructions,
  canonicalPoolAddress,
  curveBuyQuote,
  curveIdle,
  curveSellQuote,
  feeRecipients,
  hopFees,
  pickRecipients,
  pickRoute,
  poolAuthority,
  poolBuyQuote,
  poolSellQuote,
  routeBuyQuote,
  routeCoin,
  routeOk,
  routeSellQuote,
  routeSpotPrice,
  routeVariant,
  sellInstructions,
  spotPrice,
  type AmmPool,
  type BondingCurve,
  type CurveVenue,
  type Fees,
  type FeeConfig,
  type LaunchTerms,
  type PoolVenue,
  type PumpRoute,
  type PumpVenue,
  type QuoteAsset,
  type TradeRecipients,
} from '../src/background/solana/pump';
import {
  createAtaIdempotent,
  setComputeUnitLimit,
  setComputeUnitPrice,
  transfer,
} from '../src/background/solana/spl';
import {
  MAX_TX_BYTES,
  compileMessage,
  serializeTransaction,
  type Instruction,
} from '../src/background/solana/tx';
import {
  validatePumpCreate,
  validateSolanaTx,
  type PumpCreateContext,
  type SolValidationContext,
} from '../src/background/solana/validator';

// Every expected amount below is what the program itself returned: the TradeEvent /
// BuyEvent / SellEvent of a mainnet simulation, with the pre-trade state rebuilt from it.

/** Any valid address stands in for the mint. */
const MINT = findProgramAddress([seed('nesty-test-mint')], PUMP_PROGRAM);
/** A pump.fun coin other coins are paired with. */
const BASE_COIN = findProgramAddress([seed('nesty-test-base-coin')], PUMP_PROGRAM);
const CREATOR = PUMP_PROGRAM;
const address = (name: string) => findProgramAddress([seed(name)], PUMP_PROGRAM);
const FEE_RECIPIENT = address('nesty-test-fee');
const RESERVED_RECIPIENT = address('nesty-test-reserved');
const AMM_FEE_RECIPIENT = address('nesty-test-amm-fee');
const AMM_RESERVED_RECIPIENT = address('nesty-test-amm-reserved');
const USDC: QuoteAsset = { mint: USDC_MINT, program: TOKEN_PROGRAM };

const bps = (lp: number, protocol: number, creator: number): Fees => ({
  lpFeeBps: BigInt(lp),
  protocolFeeBps: BigInt(protocol),
  creatorFeeBps: BigInt(creator),
});
/** One tier from zero: the rates those coins paid at their market cap. */
const flat = (f: Fees): FeeConfig => ({
  flatFees: f,
  feeTiers: [{ threshold: 0n, fees: f }],
  stableFeeTiers: [],
  exoticFlatFees: bps(0, 0, 0),
});

function curveVenue(c: Partial<BondingCurve>, extra: Partial<CurveVenue> = {}): CurveVenue {
  return {
    kind: 'curve',
    mint: MINT,
    tokenProgram: TOKEN_PROGRAM,
    quote: SOL_QUOTE,
    curve: {
      virtualTokenReserves: 0n,
      virtualQuoteReserves: 0n,
      realTokenReserves: 0n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: CREATOR,
      isMayhemMode: false,
      isCashbackCoin: false,
      quoteMint: DEFAULT_KEY,
      creatorFeeBps: 0n,
      ...c,
    },
    curveTokenBalance: 0n,
    global: {
      poolMigrationFee: 15_000_001n,
      feeBasisPoints: 95n,
      creatorFeeBasisPoints: 30n,
      feeRecipients: [FEE_RECIPIENT],
      reservedFeeRecipients: [RESERVED_RECIPIENT],
      buybackFeeRecipients: [...BUYBACK_FEE_RECIPIENTS],
      creatorFeeConfigurable: false,
    },
    feeConfig: flat(bps(0, 95, 30)),
    mintSupply: 1_000_000_000_000_000n,
    ...extra,
  };
}

function poolVenue(base: bigint, quote: bigint, p: Partial<AmmPool> = {}): PoolVenue {
  return {
    kind: 'pool',
    mint: MINT,
    tokenProgram: TOKEN_PROGRAM,
    quote: SOL_QUOTE,
    poolAddress: DEFAULT_KEY,
    pool: {
      // Not the pump pool authority: the flat fees below apply.
      creator: CREATOR,
      baseMint: MINT,
      quoteMint: WSOL_MINT,
      poolBaseTokenAccount: DEFAULT_KEY,
      poolQuoteTokenAccount: DEFAULT_KEY,
      coinCreator: CREATOR,
      isMayhemMode: false,
      isCashbackCoin: false,
      virtualQuoteReserves: 17_568_202_953n,
      creatorFeeBps: 0n,
      protocolFees: 418_018n,
      creatorFees: 15_884_317n,
      ...p,
    },
    baseReserve: base,
    quoteReserve: quote,
    globalConfig: {
      lpFeeBasisPoints: 20n,
      protocolFeeBasisPoints: 5n,
      coinCreatorFeeBasisPoints: 95n,
      protocolFeeRecipients: [AMM_FEE_RECIPIENT],
      reservedFeeRecipients: [AMM_RESERVED_RECIPIENT],
      buybackFeeRecipients: [...BUYBACK_FEE_RECIPIENTS],
      creatorFeeConfigurable: false,
    },
    feeConfig: flat(bps(20, 5, 95)),
    mintSupply: 1_000_000_000_000_000n,
  };
}

/** A pool as pump.fun's migration made it: created by the pool authority, at its PDA. */
function canonical(v: PoolVenue, mint = v.mint, quote = v.quote): PoolVenue {
  return {
    ...v,
    mint,
    quote,
    poolAddress: canonicalPoolAddress(mint, quote.mint),
    pool: { ...v.pool, creator: poolAuthority(mint), baseMint: mint, quoteMint: quote.mint },
  };
}

const route = (...hops: PumpVenue[]): PumpRoute => ({ pay: (hops[0] as PumpVenue).quote, hops });

const curve = curveVenue({
  virtualQuoteReserves: 68_690_889_478n,
  virtualTokenReserves: 468_621_103_005_825n,
  realQuoteReserves: 38_690_889_478n,
  realTokenReserves: 188_721_103_005_825n,
});
const pool = poolVenue(121_522_102_312_725n, 127_255_897_985n);

describe('pump.fun bonding curve quotes', () => {
  it('matches buy_exact_quote_in_v3 on mainnet', () => {
    expect(curveBuyQuote(curve, 5_000_000n)).toBe(33_687_308_388n);
    expect(routeBuyQuote(route(curve), 5_000_000n)).toBe(33_687_308_388n);
  });

  it('matches sell_v3 on mainnet, after protocol and creator fees', () => {
    expect(curveSellQuote(curve, 268_734_166_360n)).toBe(38_876_601n);
    expect(routeSellQuote(route(curve), 268_734_166_360n)).toBe(38_876_601n);
  });

  it('matches a mayhem coin, priced on its real supply', () => {
    const mayhem = curveVenue(
      {
        virtualQuoteReserves: 26_749_341_119n,
        virtualTokenReserves: 1_062_837_380_578_318n,
        realQuoteReserves: 306_651_117n,
        realTokenReserves: 782_937_380_578_318n,
        isMayhemMode: true,
      },
      { curveTokenBalance: 989_837_380_578_318n, mintSupply: 2_000_000_000_000_000n },
    );
    expect(curveBuyQuote(mayhem, 5_000_000n)).toBe(196_177_137_686n);
  });

  it('charges no creator fee when the coin has no creator', () => {
    const noCreator = curveVenue({ ...curve.curve, creator: DEFAULT_KEY });
    expect(curveSellQuote(noCreator, 268_734_166_360n)).toBeGreaterThan(38_876_601n);
  });

  it('quotes a mayhem buy past the curve end as nothing (the program refuses it)', () => {
    const mayhem = curveVenue({ ...curve.curve, isMayhemMode: true });
    expect(curveBuyQuote(mayhem, 10n ** 15n)).toBe(0n);
  });

  it('quotes nothing on a complete curve', () => {
    const v = curveVenue({ ...curve.curve, complete: true });
    expect(curveIdle(v.curve)).not.toBeNull();
    expect(curveBuyQuote(v, 5_000_000n)).toBe(0n);
    expect(curveSellQuote(v, 1_000_000n)).toBe(0n);
  });

  it('quotes cashback coins like any other, but never past the curve end', () => {
    // The curve also holds the tokens its pool will open with.
    const balance = { curveTokenBalance: curve.curve.realTokenReserves + 206_900_000_000_000n };
    const regular = curveVenue({ ...curve.curve }, balance);
    const cashback = curveVenue({ ...curve.curve, isCashbackCoin: true }, balance);
    const r = route(cashback);
    expect(routeVariant(r)).toBe('curve-v2');
    expect(routeBuyQuote(r, 5_000_000n)).toBe(33_687_308_388n);
    expect(routeSellQuote(r, 268_734_166_360n)).toBe(38_876_601n);
    // v2 buys have no synthetic migration: the program refuses what the curve cannot fill.
    expect(routeBuyQuote(r, 10n ** 15n)).toBe(0n);
    expect(routeBuyQuote(route(regular), 10n ** 15n)).toBeGreaterThan(
      curve.curve.realTokenReserves,
    );
  });

  it('takes the migration fee off the pool of SOL curves only', () => {
    const near = {
      ...curve.curve,
      realTokenReserves: 1_000_000_000n,
      virtualTokenReserves: 280_000_000_000_000n,
    };
    const extra = { curveTokenBalance: 206_900_000_000_000n };
    const sol = curveVenue(near, extra);
    const usdc = curveVenue({ ...near, quoteMint: USDC_MINT }, { ...extra, quote: USDC });
    // Same reserves and fees: the USDC pool keeps the fee as quote, so its price is higher.
    const fromSol = curveBuyQuote(sol, 10_000_000_000n);
    const fromUsdc = curveBuyQuote(usdc, 10_000_000_000n);
    expect(fromUsdc).toBeGreaterThan(near.realTokenReserves);
    expect(fromUsdc).toBeLessThan(fromSol);
  });

  it('prices one raw unit from the virtual reserves', () => {
    expect(spotPrice(curve)).toBeCloseTo(68_690_889_478 / 468_621_103_005_825, 15);
  });
});

describe('PumpSwap pool quotes', () => {
  it('matches buy_exact_quote_in_v2 on mainnet, virtual quote included', () => {
    expect(poolBuyQuote(pool, 5_000_000n)).toBe(4_145_614_289n);
    expect(routeBuyQuote(route(pool), 5_000_000n)).toBe(4_145_614_289n);
  });

  it('matches sell_v2 on mainnet, after LP, protocol and creator fees', () => {
    const v = poolVenue(121_521_962_801_995n, 127_256_064_987n);
    expect(poolSellQuote(v, 33_299_441_751n)).toBe(39_197_779n);
  });

  it('quotes no sell the vault cannot pay out', () => {
    // The fees earlier trades left in the vault are not the seller's to take.
    const v = poolVenue(121_521_962_801_995n, 127_256_064_987n, {
      protocolFees: 127_256_064_987n - 30_000_000n,
      creatorFees: 0n,
    });
    expect(poolSellQuote(v, 33_299_441_751n)).toBe(0n);
  });

  it('trades cashback and mayhem pools through the v1 instructions', () => {
    expect(routeVariant(route(pool))).toBe('pool-v2');
    expect(routeVariant(route(poolVenue(1n, 1n, { isCashbackCoin: true })))).toBe('pool-v1');
    expect(routeVariant(route(poolVenue(1n, 1n, { isMayhemMode: true })))).toBe('pool-v1');
  });
});

describe('pump.fun routes', () => {
  // BASE_COIN trades on its SOL pool; MINT is still on a curve quoted in BASE_COIN.
  const baseCoin: QuoteAsset = { mint: BASE_COIN, program: TOKEN_PROGRAM };
  const basePool = canonical(pool, BASE_COIN, SOL_QUOTE);
  const coin = curveVenue({ ...curve.curve, quoteMint: BASE_COIN }, { quote: baseCoin });

  it('splits the fees of a route between its hops', () => {
    expect(hopFees('buy', 0, 1, true)).toEqual(ALL_FEES);
    expect(hopFees('buy', 0, 2, true)).toEqual({ protocol: true, creator: false, lp: false });
    expect(hopFees('buy', 1, 2, false)).toEqual({ protocol: false, creator: true, lp: false });
    expect(hopFees('sell', 0, 2, false)).toEqual({ protocol: false, creator: true, lp: false });
    expect(hopFees('sell', 1, 2, true)).toEqual({ protocol: true, creator: false, lp: false });
    expect(hopFees('buy', 1, 3, true)).toEqual({ protocol: false, creator: false, lp: false });
  });

  it('routes a coin paired with another pump.fun coin from SOL', () => {
    const r = pickRoute([coin, basePool]);
    expect(r?.pay).toEqual(SOL_QUOTE);
    expect(r?.hops).toEqual([basePool, coin]);
    expect(routeVariant(r as PumpRoute)).toBe('multi-hop');
    expect(routeCoin(r as PumpRoute)).toBe(coin);
  });

  it('prices each hop once, as multi_hop_swap charges it', () => {
    const r = route(basePool, coin);
    const mid = poolBuyQuote(basePool, 50_000_000n, hopFees('buy', 0, 2, true));
    const expected = curveBuyQuote(coin, mid, hopFees('buy', 1, 2, false));
    expect(routeBuyQuote(r, 50_000_000n)).toBe(expected);
    // Cheaper than the two trades made apart, which pay every fee twice.
    expect(expected).toBeGreaterThan(curveBuyQuote(coin, poolBuyQuote(basePool, 50_000_000n)));
    const back = poolSellQuote(
      basePool,
      curveSellQuote(coin, expected, hopFees('sell', 0, 2, false)),
      {
        protocol: true,
        creator: false,
        lp: false,
      },
    );
    expect(routeSellQuote(r, expected)).toBe(back);
    expect(routeSpotPrice(r)).toBeCloseTo(spotPrice(basePool) * spotPrice(coin), 20);
  });

  it('pays with the paired coin where multi_hop_swap refuses the route', () => {
    const cashback = { ...coin, curve: { ...coin.curve, isCashbackCoin: true } };
    const mayhemBase = canonical(poolVenue(1n, 1n, { isMayhemMode: true }), BASE_COIN, SOL_QUOTE);
    const stray = { ...basePool, poolAddress: DEFAULT_KEY };
    for (const chain of [
      [cashback, basePool],
      [coin, mayhemBase],
      [coin, stray],
    ]) {
      const r = pickRoute(chain);
      expect(r?.hops).toEqual([chain[0]]);
      expect(r?.pay).toEqual(baseCoin);
    }
    // A cashback coin next to SOL is fine.
    const cashbackBase = canonical(
      poolVenue(1n, 1n, { isCashbackCoin: true }),
      BASE_COIN,
      SOL_QUOTE,
    );
    expect(pickRoute([coin, cashbackBase])?.hops).toHaveLength(2);
  });

  it('stops at the longest route a legacy transaction fits', () => {
    const top = curveVenue({ ...curve.curve, quoteMint: MINT }, { mint: address('nesty-top') });
    const quote = { mint: MINT, program: TOKEN_PROGRAM };
    // Three deep: the user pays with the coin two hops down.
    const r = pickRoute([{ ...top, quote }, coin, basePool]);
    expect(r?.hops).toHaveLength(MAX_HOPS);
    expect(r?.pay).toEqual(baseCoin);
    const wallet = address('nesty-test-wallet');
    for (const route2 of [
      route(basePool, coin),
      route(curveVenue({ ...curve.curve }, { mint: BASE_COIN }), coin),
    ]) {
      const rec = { buyback: BUYBACK_FEE_RECIPIENTS[0] ?? '' };
      for (const t of [
        buyInstructions(route2, wallet, 1n, 1n, rec),
        sellInstructions(route2, wallet, 1n, 1n, rec),
      ]) {
        const ixs = [setComputeUnitLimit(400_000), setComputeUnitPrice(1n), ...t.instructions];
        const message = compileMessage(wallet, ixs, DEFAULT_KEY);
        expect(serializeTransaction(message, []).length).toBeLessThanOrEqual(MAX_TX_BYTES);
      }
    }
  });

  it('only chains hops quoted in the coin before them', () => {
    expect(routeOk(route(basePool, coin))).toBe(true);
    expect(routeOk({ pay: SOL_QUOTE, hops: [coin] })).toBe(false);
    expect(routeOk({ pay: SOL_QUOTE, hops: [curve, coin] })).toBe(false);
    expect(routeOk({ pay: SOL_QUOTE, hops: [] })).toBe(false);
  });

  it('pays the buyback into a listed wallet account when the trade pays into one', () => {
    expect(pickRecipients(route(basePool, coin))?.buyback).toBe(BUYBACK_FEE_RECIPIENTS[0]);
    const usdc = curveVenue({ ...curve.curve, quoteMint: USDC_MINT }, { quote: USDC });
    expect(pickRecipients(route(usdc))).toEqual({ buyback: BUYBACK_FEE_RECIPIENTS[0] });
    const cashback = pickRecipients(route(curveVenue({ ...curve.curve, isCashbackCoin: true })));
    expect(cashback?.fee).toBe(FEE_RECIPIENT);
    const mayhem = pickRecipients(route(poolVenue(1n, 1n, { isMayhemMode: true })));
    expect(mayhem?.fee).toBe(AMM_RESERVED_RECIPIENT);
  });
});

describe('Solana trade validator', () => {
  const wallet = address('nesty-test-wallet');
  const other = address('nesty-test-other');
  const buyback = BUYBACK_FEE_RECIPIENTS[0] ?? '';
  const baseCoin: QuoteAsset = { mint: BASE_COIN, program: TOKEN_PROGRAM };
  const basePool = canonical(pool, BASE_COIN, SOL_QUOTE);
  const baseCurve = curveVenue({ ...curve.curve }, { mint: BASE_COIN });
  const onCurve = curveVenue({ ...curve.curve, quoteMint: BASE_COIN }, { quote: baseCoin });
  const onPool = canonical(pool, MINT, baseCoin);

  /** Every kind of trade Nesty builds. */
  const routes: Record<string, PumpRoute> = {
    'curve v3': route(curve),
    'curve v3, USDC-quoted': route(
      curveVenue({ ...curve.curve, quoteMint: USDC_MINT }, { quote: USDC }),
    ),
    'curve v2 (cashback)': route(curveVenue({ ...curve.curve, isCashbackCoin: true })),
    'curve v2 (cashback, mayhem)': route(
      curveVenue({ ...curve.curve, isCashbackCoin: true, isMayhemMode: true }),
    ),
    'pool v2': route(canonical(pool)),
    'pool v1 (mayhem)': route(canonical(poolVenue(1n, 1n, { isMayhemMode: true }))),
    'pool v1 (cashback)': route(canonical(poolVenue(1n, 1n, { isCashbackCoin: true }))),
    'pool v1 (no coin creator)': route(
      canonical(poolVenue(1n, 1n, { isCashbackCoin: true, coinCreator: DEFAULT_KEY })),
    ),
    'pool v2, USDC-quoted': route(canonical(pool, MINT, USDC)),
    'multi-hop from a pool': route(basePool, onCurve),
    'multi-hop from a curve': route(baseCurve, onPool),
  };

  const recipients = (r: PumpRoute): TradeRecipients => {
    const variant = routeVariant(r);
    return variant === 'curve-v2' || variant === 'pool-v1'
      ? { buyback, fee: feeRecipients(routeCoin(r))[0] ?? '' }
      : { buyback };
  };
  const ctx = (r: PumpRoute, c: Partial<SolValidationContext> = {}): SolValidationContext => ({
    wallet,
    mint: routeCoin(r).mint,
    route: r,
    side: 'buy',
    maxSpend: 1_000_000_000n,
    maxPriorityLamports: 10_000_000n,
    ...c,
  });
  /** What the service sends: compute budget first, then the trade. */
  const withBudget = (ixs: Instruction[], units = 220_000, microLamports = 2_272_727n) => [
    setComputeUnitLimit(units),
    setComputeUnitPrice(microLamports),
    ...ixs,
  ];
  const buy = (r: PumpRoute, amount = 5_000_000n, minOut = 1n, rec = recipients(r)) =>
    buyInstructions(r, wallet, amount, minOut, rec).instructions;
  const sell = (r: PumpRoute, minOut = 1n) =>
    sellInstructions(r, wallet, 1_000_000n, minOut, recipients(r)).instructions;
  const reasons = (ixs: Instruction[], r: PumpRoute, c?: Partial<SolValidationContext>) =>
    validateSolanaTx(ixs, ctx(r, c))
      .actions.filter((a) => !a.ok)
      .map((a) => a.reason);
  const curveRoute = routes['curve v3'] as PumpRoute;
  const poolRoute = routes['pool v2'] as PumpRoute;

  for (const [name, r] of Object.entries(routes)) {
    it(`passes the ${name} trades Nesty builds`, () => {
      const lamports = 50_000_000n;
      const bought = validateSolanaTx(withBudget(buy(r, lamports)), ctx(r));
      expect(bought.actions.filter((a) => !a.ok)).toEqual([]);
      expect(bought.spend).toBe(lamports);
      const sold = validateSolanaTx(withBudget(sell(r)), ctx(r, { side: 'sell' }));
      expect(sold.actions.filter((a) => !a.ok)).toEqual([]);
    });
  }

  it('blocks a buy above the per-transaction limit', () => {
    expect(reasons(buy(curveRoute, 2_000_000_000n), curveRoute)).toContain(
      'Above your per-transaction limit',
    );
  });

  it('blocks trades without a minimum received', () => {
    expect(reasons(buy(curveRoute, 5_000_000n, 0n), curveRoute)).toContain('No minimum received');
    expect(reasons(sell(poolRoute, 0n), poolRoute, { side: 'sell' })).toContain(
      'No minimum received',
    );
  });

  it('blocks a trade for another token or wallet', () => {
    const forOther = buyInstructions(curveRoute, other, 5_000_000n, 1n, { buyback });
    expect(validateSolanaTx(forOther.instructions, ctx(curveRoute)).ok).toBe(false);
    const elsewhere = route({ ...curve, mint: other });
    expect(reasons(buy(elsewhere), elsewhere, { mint: MINT })).toContain(
      'Does not lead to this token',
    );
    expect(reasons(buy(elsewhere), curveRoute)).toContain('Accounts are not this token and wallet');
  });

  it('blocks a route that does not chain', () => {
    const broken: PumpRoute = { pay: SOL_QUOTE, hops: [curve, onCurve] };
    expect(reasons(buy(broken), broken)).toContain('Does not lead to this token');
  });

  it('blocks fee recipients pump.fun does not list', () => {
    expect(reasons(buy(curveRoute, 5_000_000n, 1n, { buyback: other }), curveRoute)).toContain(
      'Accounts are not this token and wallet',
    );
    const cashback = routes['curve v2 (cashback)'] as PumpRoute;
    // A mayhem coin's recipient on a regular coin, then one not listed at all.
    for (const fee of [RESERVED_RECIPIENT, other]) {
      expect(reasons(buy(cashback, 5_000_000n, 1n, { buyback, fee }), cashback)).toContain(
        'Accounts are not this token and wallet',
      );
    }
  });

  it('blocks opening an account the trade does not need', () => {
    const r = routes['multi-hop from a pool'] as PumpRoute;
    const extra = createAtaIdempotent(other, WSOL_MINT, TOKEN_PROGRAM, wallet);
    expect(reasons([extra, ...buy(r)], r)).toContain('Not an account this trade needs');
    // A listed wallet's account, but in another token than the trade pays.
    const usdcAccount = createAtaIdempotent(buyback, USDC_MINT, TOKEN_PROGRAM, wallet);
    expect(reasons([usdcAccount, ...buy(r)], r)).toContain('Not an account this trade needs');
  });

  it('blocks SOL sent anywhere but your own wrapped SOL', () => {
    expect(reasons([transfer(wallet, other, 1n), ...buy(curveRoute)], curveRoute)).toContain(
      'Only one transfer to your own wrapped SOL',
    );
    const usdc = routes['curve v3, USDC-quoted'] as PumpRoute;
    const wsol = associatedTokenAddress(wallet, WSOL_MINT);
    expect(reasons([transfer(wallet, wsol, 1n), ...buy(usdc)], usdc)).toContain(
      'Only one transfer to your own wrapped SOL',
    );
  });

  it('blocks a pool buy that wraps more than it spends', () => {
    const ixs = buy(poolRoute);
    const wrap = ixs.findIndex((ix) => ix.programId === DEFAULT_KEY);
    const bigger = ixs.map((ix, i) =>
      i === wrap ? transfer(wallet, ix.keys[1]?.pubkey ?? '', 9_000_000n) : ix,
    );
    expect(reasons(bigger, poolRoute)).toContain('Does not wrap what the trade spends');
  });

  it('blocks unknown programs, other signers and a second trade', () => {
    const ixs = buy(curveRoute);
    const stranger: Instruction = { programId: other, keys: [], data: new Uint8Array() };
    expect(reasons([...ixs, stranger], curveRoute)).toContain('Program is not on the allowlist');
    const cosigned = ixs.map((ix) =>
      ix.programId === PUMP_PROGRAM
        ? { ...ix, keys: [...ix.keys, { pubkey: other, isSigner: true, isWritable: false }] }
        : ix,
    );
    expect(reasons(cosigned, curveRoute)).toContain('Only your wallet may sign');
    expect(reasons([...ixs, ...ixs.slice(1)], curveRoute)).toContain(
      'Exactly one trade per transaction',
    );
  });

  it('blocks a buy sent as a sell, partial fills and untracked volume', () => {
    const ixs = buy(curveRoute);
    expect(reasons(ixs, curveRoute, { side: 'sell' })).toContain('Unknown instruction');
    const flagged = (list: Instruction[], program: string, flag: number) =>
      list.map((ix) =>
        ix.programId === program
          ? { ...ix, data: Uint8Array.of(...ix.data.slice(0, 24), flag) }
          : ix,
      );
    expect(reasons(flagged(ixs, PUMP_PROGRAM, 1), curveRoute)).toContain(
      'Partial fills are not allowed',
    );
    const v1 = routes['pool v1 (cashback)'] as PumpRoute;
    expect(reasons(flagged(buy(v1), PUMP_AMM_PROGRAM, 0), v1)).toContain(
      'Volume tracking must stay on',
    );
  });

  it('blocks a priority fee above the max network fee', () => {
    const ixs = buy(curveRoute);
    // 220 000 units at 100 000 000 micro-lamports each: 0.022 SOL.
    expect(reasons(withBudget(ixs, 220_000, 100_000_000n), curveRoute)).toContain(
      'Above your max network fee',
    );
    expect(reasons(withBudget(ixs, 1_500_000), curveRoute)).toContain('Above the maximum');
  });

  it('keeps each trade on the program and version its coin takes', () => {
    const swapped = buy(poolRoute).map((ix) =>
      ix.programId === PUMP_AMM_PROGRAM ? { ...ix, programId: PUMP_PROGRAM } : ix,
    );
    expect(reasons(swapped, poolRoute)).toContain('Not the trade this token takes');
    // A cashback coin's v2 trade, presented as the v3 trade of a regular one.
    const cashback = routes['curve v2 (cashback)'] as PumpRoute;
    expect(validateSolanaTx(buy(cashback), ctx(curveRoute)).ok).toBe(false);
  });
});

describe('new pump.fun coins from the Nesty website', () => {
  const wallet = address('nesty-test-wallet');
  const other = address('nesty-test-other');
  const mint = address('nesty-test-new-coin');
  // What pump.fun's Global gives every coin made now.
  const launch: LaunchTerms = {
    initialVirtualTokenReserves: 1_073_000_000_000_000n,
    initialVirtualSolReserves: 30_000_000_000n,
    initialRealTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    createV2Enabled: true,
  };
  const fresh = freshRoute(mint, wallet, curve.global, launch, flat(bps(0, 95, 30)));
  const devBuy = 100_000_000n;
  const coin = {
    mint,
    name: 'Nesty Test',
    symbol: 'CTEST',
    uri: 'ipfs://bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva',
    devBuy,
    minOut: devBuyQuote(fresh, devBuy) / 2n,
  };
  const ctx = (c: Partial<PumpCreateContext['coin']> = {}): PumpCreateContext => ({
    wallet,
    coin: { ...coin, ...c },
    route: fresh,
    maxSpend: 1_000_000_000n,
    maxPriorityLamports: 10_000_000n,
  });
  /** What the site sends: its compute budget, then the coin Nesty builds. */
  const built = (
    c: Partial<PumpCreateContext['coin']> = {},
    user = wallet,
    rec = pickRecipients(fresh),
    microLamports = 2_272_727n,
  ) => [
    setComputeUnitLimit(400_000),
    setComputeUnitPrice(microLamports),
    ...createInstructions({ ...coin, ...c, user }, fresh, rec),
  ];
  const reasons = (ixs: Instruction[], c: Partial<PumpCreateContext['coin']> = {}) =>
    validatePumpCreate(ixs, ctx(c))
      .actions.filter((a) => !a.ok)
      .map((a) => a.reason);

  it('passes the coin Nesty builds, with its dev buy or without', () => {
    const made = validatePumpCreate(built(), ctx());
    expect(made.actions.filter((a) => !a.ok)).toEqual([]);
    expect(made.spend).toBe(devBuy);
    expect(made.actions.map((a) => a.label)).toEqual([
      'Compute limit 400000',
      'Create CTEST on pump.fun',
      'Buy it for 0.1 SOL',
      'Priority fee 0.000909091 SOL',
    ]);
    const bare = { devBuy: 0n, minOut: 0n };
    expect(validatePumpCreate(built(bare), ctx(bare)).ok).toBe(true);
  });

  it('quotes a dev buy on the fresh curve, and none that would buy all of it', () => {
    expect(coin.minOut).toBeGreaterThan(0n);
    expect(devBuyQuote(fresh, 1_000_000_000_000n)).toBe(0n);
  });

  it('blocks a coin that is not the one the site says', () => {
    // Another name, or another ticker, than the one the user saw.
    expect(reasons(built({ name: 'Nesty Tset' }))).toContain('Not the coin it says it is');
    expect(reasons(built({ symbol: 'CTSET' }))).toContain('Not the coin it says it is');
    // Created, and bought, for someone else.
    expect(reasons(built({}, other))).toEqual(
      expect.arrayContaining([
        'Only your wallet and the new coin may sign',
        'Not the coin it says it is',
      ]),
    );
    // A dev buy that pays a wallet pump.fun does not list.
    expect(reasons(built({}, wallet, { buyback: other }))).toContain('Not the coin it says it is');
    // Anything more in the same transaction.
    expect(reasons([...built(), transfer(wallet, other, 1n)])).toContain(
      'Not the coin it says it is',
    );
  });

  it('holds the dev buy to the per-transaction limit and a minimum received', () => {
    const big = { devBuy: 2_000_000_000n, minOut: 1n };
    expect(reasons(built(big), big)).toContain('Above your per-transaction limit');
    const loose = { minOut: 0n };
    expect(reasons(built(loose), loose)).toContain('No minimum received');
  });

  it('blocks a priority fee above the max network fee', () => {
    expect(reasons(built({}, wallet, pickRecipients(fresh), 100_000_000n))).toContain(
      'Above your max network fee',
    );
  });
});
