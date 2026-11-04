import {
  encodeAbiParameters,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { FOUR_TM, launchpadVenues } from '../src/background/trade/launchpads';
import { probeTax, taxRefusal, totalBuyBps, totalSellBps } from '../src/background/trade/tax';
import type { Venue, VenueCtx } from '../src/background/trade/types';
import { getChain } from '../src/shared/chains';

/**
 * A four.meme tax token on its curve: the manager takes the token's rates on each trade, in
 * BNB, besides its 1% fee, and the helper's tryBuy / trySell leave them out. Fee and rates
 * both count as tax. Figures are BECKY's (10% / 10%) on BSC, read from the helper; a
 * simulated 0.01 BNB buy delivered exactly the taxed quote, and sells paid trySell's funds
 * less 10% of funds + fee, to the wei.
 */
const four = launchpadVenues.find((v) => v.id === 'fourmeme') as Venue;
const BECKY: Address = '0x2A1228284558Bc1DFD4ac043C0d1ed033f02fFff';
const BUY_IN = 10n ** 16n;
const UNTAXED_OUT = 2_182_140_624_501_550_000_000_000n; // tryBuy(0.01 BNB)
const TAXED_IN = 9_099_099_099_099_099n; // 0.01 BNB × 1.01 / 1.11
const TAXED_OUT = 1_985_914_898_231_166_000_000_000n; // tryBuy(TAXED_IN): what the chain gave
const HALF = TAXED_OUT / 2n;
const SELL_FUNDS = 4_447_101_700_907_605n; // trySell(HALF)
const SELL_FEE = 44_920_219_201_086n;
const SELL_PAID = SELL_FUNDS - ((SELL_FUNDS + SELL_FEE) * 10n) / 100n;

type Rates = Partial<Record<'feeRateBuy' | 'feeRateSell' | 'feeRate', bigint>>;
type Read = { functionName: string; args?: readonly unknown[] };

interface Opts {
  /** The funds tryBuy was asked to price, in order. */
  asked?: bigint[];
  /** four.meme's fee, in basis points: 1% on chain. */
  fee?: bigint;
  /** trySell refuses: the probe cannot measure its sell. */
  noSellQuote?: boolean;
}

/** four.meme's helper and a token with `rates`; tryBuy answers from `curve`. */
function fakeClient(rates: Rates, curve: Map<bigint, bigint>, opts: Opts = {}) {
  const answer = ({ functionName, args = [] }: Read): unknown => {
    if (functionName === 'getTokenInfo')
      return [2n, FOUR_TM, zeroAddress, 0n, opts.fee ?? 100n, 0n, 0n, 1n, 1n, 0n, 1n, false];
    if (functionName in rates) return rates[functionName as keyof Rates];
    if (functionName === 'tryBuy') {
      const funds = args[2] as bigint;
      opts.asked?.push(funds);
      const out = curve.get(funds);
      if (out === undefined) throw new Error(`tryBuy(${funds}) not in the fixture`);
      return [FOUR_TM, zeroAddress, out, 0n, 0n, 0n, 0n, 0n];
    }
    if (functionName === 'trySell' && !opts.noSellQuote)
      return [FOUR_TM, zeroAddress, SELL_FUNDS, SELL_FEE];
    throw new Error(`reverted: ${functionName}`);
  };
  const word = (v: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [v]);
  const sel = (sig: string) => toFunctionSelector(sig);
  // The probe's buy, balance, approval and sell, as the chain ran them.
  const simulate = (calls: { data: Hex }[]) => {
    let eth = 10n ** 18n;
    return calls.map(({ data }) => {
      const s = data.slice(0, 10);
      if (s === sel('function balanceOf(address)')) return word(TAXED_OUT);
      if (s === sel('function getEthBalance(address)')) return word(eth);
      if (s === sel('function sellToken(uint256,address,uint256,uint256)')) eth += SELL_PAID;
      return '0x';
    });
  };
  return {
    multicall: async ({ contracts }: { contracts: Read[] }) =>
      contracts.map((c) => {
        try {
          return { status: 'success', result: answer(c) };
        } catch (error) {
          return { status: 'failure', error };
        }
      }),
    readContract: async (c: Read) => answer(c),
    simulateCalls: async ({ calls }: { calls: { data: Hex }[] }) => ({
      results: simulate(calls).map((data) => ({ status: 'success', data })),
    }),
  } as unknown as PublicClient;
}

const ctxWith = (client: PublicClient): VenueCtx => ({
  chain: getChain(56)!,
  client,
  now: () => 1_793_800_000_000,
});

const beckyCurve = new Map([
  [BUY_IN, UNTAXED_OUT],
  [TAXED_IN, TAXED_OUT],
]);

describe('four.meme tax tokens on their curve', () => {
  it('quote what the chain pays, the tax taken, not what tryBuy and trySell say', async () => {
    const ctx = ctxWith(fakeClient({ feeRateBuy: 10n, feeRateSell: 10n }, beckyCurve));
    const [ref] = await four.discover(ctx, BECKY);
    expect(ref).toBeDefined();
    expect(await four.quote(ctx, ref!, 'buy', [BUY_IN])).toEqual([TAXED_OUT]);
    expect(await four.quote(ctx, ref!, 'sell', [HALF])).toEqual([SELL_PAID]);
  });

  it('report the fee and the token rates as the tax, for the panel and Max tax', async () => {
    const ctx = ctxWith(fakeClient({ feeRateBuy: 10n, feeRateSell: 10n }, beckyCurve));
    const [ref] = await four.discover(ctx, BECKY);
    const [out] = await four.quote(ctx, ref!, 'buy', [BUY_IN]);
    const info = await probeTax(ctx, four, ref!, BUY_IN, out!);
    // Nothing falls short of the quote, and the token takes nothing itself on its curve: the
    // whole tax is the venue's, its 1% fee and the token's rates.
    expect(info).toEqual({
      transfer: { buyBps: 0, sellBps: 0 },
      venue: { buyBps: 1100, sellBps: 1100 },
      declared: { buyBps: 0, sellBps: 0 },
      sellFails: false,
    });
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([1100, 1100]);
    expect(taxRefusal(info, 1100)).toBeNull();
    expect(taxRefusal(info, 1000)).toBe('Tax 11% buy / 11% sell, max 10%.');
  });

  it('know the sell when the probe cannot measure it', async () => {
    // trySell still quoted the newest curves when checked; should it refuse, the token's own
    // transfers are untaxed on its curve, so the sell costs the venue's tax and no more.
    const ctx = ctxWith(
      fakeClient({ feeRateBuy: 10n, feeRateSell: 10n }, beckyCurve, { noSellQuote: true }),
    );
    const [ref] = await four.discover(ctx, BECKY);
    const info = await probeTax(ctx, four, ref!, BUY_IN, TAXED_OUT);
    expect(info?.transfer.sellBps).toBeNull();
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([1100, 1100]);
  });

  it('keep a buy rate and a sell rate apart', async () => {
    const asked: bigint[] = [];
    // 1% buy: tryBuy is asked for 0.01 BNB × 1.01 / 1.02.
    const curve = new Map([[9_901_960_784_313_725n, 1n]]);
    const ctx = ctxWith(fakeClient({ feeRateBuy: 1n, feeRateSell: 4n }, curve, { asked }));
    const [ref] = await four.discover(ctx, BECKY);
    expect(await four.venueTax!(ctx, ref!)).toEqual({ buyBps: 200, sellBps: 500 });
    expect(await four.quote(ctx, ref!, 'buy', [BUY_IN])).toEqual([1n]);
    expect(asked).toEqual([9_901_960_784_313_725n]);
    // 4% of funds + fee comes off the sell.
    const [sold] = await four.quote(ctx, ref!, 'sell', [HALF]);
    expect(sold).toBe(SELL_FUNDS - ((SELL_FUNDS + SELL_FEE) * 4n) / 100n);
  });

  it("take an older token's single rate for both sides", async () => {
    const ctx = ctxWith(fakeClient({ feeRate: 5n }, new Map()));
    const [ref] = await four.discover(ctx, BECKY);
    expect(await four.venueTax!(ctx, ref!)).toEqual({ buyBps: 600, sellBps: 600 });
  });

  it("follow the token's own fee, should four.meme set another", async () => {
    const asked: bigint[] = [];
    // A 2% fee and a 10% buy: tryBuy is asked for 0.01 BNB × 1.02 / 1.12.
    const curve = new Map([[9_107_142_857_142_857n, 1n]]);
    const ctx = ctxWith(
      fakeClient({ feeRateBuy: 10n, feeRateSell: 10n }, curve, { asked, fee: 200n }),
    );
    const [ref] = await four.discover(ctx, BECKY);
    expect(await four.venueTax!(ctx, ref!)).toEqual({ buyBps: 1200, sellBps: 1200 });
    expect(await four.quote(ctx, ref!, 'buy', [BUY_IN])).toEqual([1n]);
    expect(asked).toEqual([9_107_142_857_142_857n]);
  });

  it('quote a token without tax as tryBuy and trySell do, its fee the only tax', async () => {
    const ctx = ctxWith(fakeClient({}, beckyCurve));
    const [ref] = await four.discover(ctx, BECKY);
    expect(await four.venueTax!(ctx, ref!)).toEqual({ buyBps: 100, sellBps: 100 });
    expect(await four.quote(ctx, ref!, 'buy', [BUY_IN])).toEqual([UNTAXED_OUT]);
    expect(await four.quote(ctx, ref!, 'sell', [HALF])).toEqual([SELL_FUNDS]);
  });
});
