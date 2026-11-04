import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { probeTax, totalSellBps } from '../../src/background/trade/tax';
import type { Venue, VenueCtx } from '../../src/background/trade/types';
import { getChain } from '../../src/shared/chains';

/**
 * Flap tax tokens on their curve: the portal takes the token's buy or sell rate from each
 * trade besides its 1% fee, so the quote must already hold them (no shortfall in a simulated
 * buy and sell) and the venue reports fee and rates as the tax. An untaxed TokenV3 pays 1.25%
 * instead of the fee. Candidates that left their curve are skipped.
 */
const pool = new ClientPool();
const flap = launchpadVenues.find((v) => v.id === 'flap') as Venue;

/** [token, buy bps, sell bps, the curve's fee in bps when not Flap's 1%]. */
type Candidate = [Address, number, number, number?];
const BSC: Candidate[] = [
  ['0xF02a6C1a0127C9401c7aDED92a80D62764967777', 900, 900], // SOBINC
  ['0x23351eb9331fAB16051078e6AcB21CAe1C587777', 900, 900], // MAXSTONK
  ['0xF42d0c5Ba0fCB54668f92edcfaa75b3Cb6107777', 200, 300], // FishingAI
  ['0x56B0a188330b12cfc9De86A46766436066A07777', 200, 100],
];
/** The oldest kind (FlapTaxToken): one rate, and no getPoolStateData to read it from. */
const BSC_V1: Candidate[] = [
  ['0xf9B307EDED0527D7815E06F2298abaDc7c3C7777', 500, 500], // GCF
  ['0x8d238cbc7A106076196588E1eB28D62C07aB7777', 300, 300], // DONATIONS
];
/** Untaxed TokenV3 coins (getTokenV8Safe version 7). */
const BSC_UNTAXED_V3: Candidate[] = [
  ['0xE2E00447b82A76Dd14d06D2176db0781fdDE8888', 0, 0, 125], // AERA
  ['0x88178EF7C5116d097ca36b403219e36332Fc8888', 0, 0, 125], // GTA 6
];
const BASE: Candidate[] = [
  ['0xb4bd5B1A12C494d85b1F1bb9d30f9ae00dD17777', 900, 900], // ADEO
  ['0xe7DDfa7dAC5C759411c4Fb3162bf8302137F7777', 900, 900], // PLAMP
];
const ROBINHOOD: Candidate[] = [
  ['0x1F855632995854FE76a17E403b678512c6eb7777', 900, 900], // ECHO
  ['0x1cDa130779f715e9D7bc53E3983B339Cd2A47777', 1000, 1000], // Cikipi
];

async function measure(chainId: number, candidates: Candidate[], amount: string) {
  const chain = getChain(chainId)!;
  const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
  const amountIn = parseEther(amount);
  for (const [token, buy, sell, fee = 100] of candidates) {
    const [ref] = await flap.discover(ctx, token);
    if (!ref) continue;
    const [out] = await flap.quote(ctx, ref, 'buy', [amountIn]);
    if (!out) continue;
    const info = await probeTax(ctx, flap, ref, amountIn, out);
    return { info, buy, sell, fee };
  }
  return null;
}

function check(r: NonNullable<Awaited<ReturnType<typeof measure>>>) {
  expect(r.info, 'probe').not.toBeNull();
  const info = r.info!;
  expect(info.sellFails).toBe(false);
  // What arrived matches the quote: the tax is in it, not taken on top.
  expect(info.transfer.buyBps).toBeLessThan(10);
  expect(info.transfer.sellBps ?? 0).toBeLessThan(10);
  // On its curve the token takes nothing itself, so a sell too large to measure is known.
  expect(info.declared).toEqual({ buyBps: 0, sellBps: 0 });
  expect(totalSellBps(info)).toBeGreaterThanOrEqual(r.fee + r.sell);
  expect(totalSellBps(info)).toBeLessThan(r.fee + r.sell + 10);
  expect(info.venue).toEqual({ buyBps: r.fee + r.buy, sellBps: r.fee + r.sell });
}

describe('Flap tax tokens on their curve (mainnet simulation, no funds)', () => {
  it('BSC', async (t) => {
    const r = await measure(56, BSC, '0.01');
    if (!r) return t.skip();
    check(r);
  });

  it('BSC, the oldest tokens', async (t) => {
    const r = await measure(56, BSC_V1, '0.01');
    if (!r) return t.skip();
    check(r);
  });

  it('BSC, an untaxed TokenV3', async (t) => {
    const r = await measure(56, BSC_UNTAXED_V3, '0.01');
    if (!r) return t.skip();
    check(r);
  });

  it('Base', async (t) => {
    const r = await measure(8453, BASE, '0.001');
    if (!r) return t.skip();
    check(r);
  });

  it('Robinhood', async (t) => {
    const r = await measure(4663, ROBINHOOD, '0.001');
    if (!r) return t.skip();
    check(r);
  });
});
