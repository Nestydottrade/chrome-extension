import {
  encodeAbiParameters,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { FLAP_PORTALS, launchpadVenues } from '../src/background/trade/launchpads';
import { probeTax, taxRefusal, totalBuyBps, totalSellBps } from '../src/background/trade/tax';
import type { PoolRef, Venue, VenueCtx } from '../src/background/trade/types';
import { getChain } from '../src/shared/chains';

/**
 * A Flap tax token on its curve: its own transfers are untaxed there, and the portal takes its
 * buy or sell rate from each trade's value (in BNB, wrapped, to its tax processor) besides
 * Flap's 1% fee; quoteExactInput already holds both. Figures are SOBINC's (9% / 9%) on BSC: a
 * simulated 0.01 BNB buy paid 0.0001 BNB fee and 0.0009 BNB tax and delivered exactly the
 * quote, and selling half of it delivered exactly that sell's quote.
 */
const flap = launchpadVenues.find((v) => v.id === 'flap') as Venue;
const SOBINC: Address = '0xF02a6C1a0127C9401c7aDED92a80D62764967777';
const BUY_IN = 10n ** 16n;
const TOKENS = 1_620_316_069_505_390_830_244_348n; // quoteExactInput(0.01 BNB), and what arrived
const SELL_NET = 4_052_966_066_134_442n; // quoteExactInput(half) after that buy, and what arrived

interface Token {
  /** The portal's record of its buy and sell rates, in basis points. */
  rates: [bigint, bigint];
  /** And of its kind: 6 a V3 tax token (the default), 2 an untaxed V2, 7 an untaxed TokenV3. */
  version?: number;
  /** Its getPoolStateData state (0 on its curve, 3 in its pool); none for the oldest tokens. */
  state?: number;
  /** Its curve is too small to quote a sell of half the probe's buy before that buy lands. */
  noSellQuote?: boolean;
}
type Read = { functionName: string; args?: readonly unknown[] };

/** The BSC portal, a token on its curve quoted in BNB, and the probe's buy and sell. */
function fakeClient(t: Token) {
  const answer = ({ functionName, args = [] }: Read): unknown => {
    if (functionName === 'getTokenV3') return [1, 0n, 0n, 0n, 5, 0n, 0n, zeroAddress, false];
    if (functionName === 'getTokenV8Safe')
      return {
        status: 1,
        tokenVersion: t.version ?? 6,
        buyTaxRate: t.rates[0],
        sellTaxRate: t.rates[1],
      };
    if (functionName === 'getPoolStateData' && t.state !== undefined)
      return [t.state, Number(t.rates[0]), Number(t.rates[1]), 0n, 3_153_600_000n, 0n];
    if (functionName === 'quoteExactInput') {
      const [{ inputToken }] = args as [{ inputToken: Address }];
      if (inputToken === zeroAddress) return TOKENS;
      if (t.noSellQuote) throw new Error('reverted: quoteExactInput');
      return SELL_NET;
    }
    throw new Error(`reverted: ${functionName}`);
  };
  const word = (v: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [v]);
  const sel = (sig: string) => toFunctionSelector(sig);
  // The probe's buy, balance, approval and sell, as the chain ran them: what was quoted arrives.
  const simulate = (calls: { data: Hex }[]) => {
    let balances = 0;
    return calls.map(({ data }) => {
      const s = data.slice(0, 10);
      if (s === sel('function balanceOf(address)')) return word(TOKENS);
      if (s === sel('function getEthBalance(address)'))
        return word(10n ** 18n + (balances++ === 0 ? 0n : SELL_NET));
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

async function measure(t: Token) {
  const ctx = ctxWith(fakeClient(t));
  const [ref] = await flap.discover(ctx, SOBINC);
  expect(ref?.data).toEqual({ portal: FLAP_PORTALS[56]![0] });
  return { ctx, ref: ref!, info: await probeTax(ctx, flap, ref!, BUY_IN, TOKENS) };
}

describe('Flap tax tokens on their curve', () => {
  it("report the rates the portal takes, besides its fee, as the venue's", async () => {
    const { info } = await measure({ rates: [900n, 900n], state: 0 });
    // Nothing falls short of the quote, and the token takes nothing itself on its curve.
    expect(info).toEqual({
      transfer: { buyBps: 0, sellBps: 0 },
      venue: { buyBps: 1000, sellBps: 1000 },
      declared: { buyBps: 0, sellBps: 0 },
      sellFails: false,
    });
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([1000, 1000]);
    expect(taxRefusal(info, 1000)).toBeNull();
    expect(taxRefusal(info, 900)).toBe('Tax 10% buy / 10% sell, max 9%.');
  });

  it('keep a buy rate and a sell rate apart', async () => {
    const a = await measure({ rates: [200n, 300n], state: 0 });
    expect([totalBuyBps(a.info!), totalSellBps(a.info!)]).toEqual([300, 400]);
    const b = await measure({ rates: [0n, 100n], state: 0 });
    expect([totalBuyBps(b.info!), totalSellBps(b.info!)]).toEqual([100, 200]);
  });

  it('know the sell on a curve too small to measure it', async () => {
    const { info } = await measure({ rates: [900n, 900n], state: 0, noSellQuote: true });
    expect(info?.transfer.sellBps).toBeNull();
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([1000, 1000]);
  });

  it("count the oldest tokens' rate, which they have no rate getter for", async () => {
    // FlapTaxToken (V1): no getPoolStateData; GCF 0xf9B3…7777 paid 5% on its curve too, and
    // its transfers there were untaxed, as every Flap token's are.
    const { info } = await measure({ rates: [500n, 500n], version: 4 });
    expect(info?.declared).toEqual({ buyBps: 0, sellBps: 0 });
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([600, 600]);
    const small = await measure({ rates: [500n, 500n], version: 4, noSellQuote: true });
    expect([totalBuyBps(small.info!), totalSellBps(small.info!)]).toEqual([600, 600]);
  });

  it("count Flap's fee on an untaxed token", async () => {
    const { ctx, ref } = await measure({ rates: [0n, 0n], version: 2 });
    expect(await flap.venueTax!(ctx, ref)).toEqual({ buyBps: 100, sellBps: 100 });
  });

  it("count an untaxed TokenV3's 1.25% instead of Flap's fee", async () => {
    // AERA 0xE2E0…8888 on BSC: a 0.01 BNB buy paid 0.000125 BNB to its tax processor, no fee.
    const { info } = await measure({ rates: [0n, 0n], version: 7 });
    expect(info?.venue).toEqual({ buyBps: 125, sellBps: 125 });
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([125, 125]);
    const small = await measure({ rates: [0n, 0n], version: 7, noSellQuote: true });
    expect([totalBuyBps(small.info!), totalSellBps(small.info!)]).toEqual([125, 125]);
  });
});

describe('a Flap tax token in its pool', () => {
  it('counts the rates its token takes itself', async () => {
    // A pool that is no launchpad (no venue tax), trading the token as a v2 pair would.
    const pool: Venue = {
      id: 'pool',
      supports: () => true,
      discover: async () => [],
      quote: (ctx, ref, side, amounts) => flap.quote(ctx, ref, side, amounts),
      buildBuy: (ctx, ref, p) => flap.buildBuy(ctx, ref, p),
      buildSell: (ctx, ref, p) => flap.buildSell(ctx, ref, p),
      sellApproval: (ctx, ref) => flap.sellApproval(ctx, ref),
    };
    const ref: PoolRef = {
      venueId: 'pool',
      id: 'pool',
      label: 'v2',
      token: SOBINC,
      data: { portal: FLAP_PORTALS[56]![0] },
    };
    const ctx = ctxWith(fakeClient({ rates: [300n, 500n], state: 3 }));
    const info = await probeTax(ctx, pool, ref, BUY_IN, TOKENS);
    expect(info?.declared).toEqual({ buyBps: 300, sellBps: 500 });
    expect([totalBuyBps(info!), totalSellBps(info!)]).toEqual([300, 500]);
  });
});
