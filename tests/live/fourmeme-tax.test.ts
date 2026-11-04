import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { probeTax } from '../../src/background/trade/tax';
import type { Venue, VenueCtx } from '../../src/background/trade/types';
import { getChain } from '../../src/shared/chains';

/**
 * four.meme tax tokens on their curve: the manager takes its fee and the token's rates on
 * each curve trade, so the quote must already hold them (no shortfall in a simulated buy and
 * sell) and the venue reports them together as the tax. Candidates that left their curve are
 * skipped.
 */
const pool = new ClientPool();
const four = launchpadVenues.find((v) => v.id === 'fourmeme') as Venue;
/** four.meme's own fee: 1% on every token seen. */
const FEE_BPS = 100;

/** [token, buy %, sell %]. */
const CANDIDATES: [Address, number, number][] = [
  ['0x2A1228284558Bc1DFD4ac043C0d1ed033f02fFff', 10, 10], // BECKY
  ['0xA60401F96003031Dd0F9D4cc54E9b2C62e15Ffff', 1, 4],
  ['0x2deE22F93BFc4f61e5D33A99f4bf03999d4CFFfF', 2, 3],
  ['0xd13d11eA0a96fce478f6E870Cea5c80Cc76BfFff', 1, 4],
];
/** Quoted in a BEP-20 (bought through the helper): the tax is taken in that asset. */
const VIA_ASSET: [Address, number, number][] = [
  ['0x0941cB7a4f60971B5A3D4040628630B9BAE4FfFf', 3, 3],
  ['0xCC0D52f2aa9cDc316F5297fcF25f3f1d0aEefffF', 3, 3],
];

async function measure(candidates: [Address, number, number][]) {
  const chain = getChain(56)!;
  const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
  const amountIn = parseEther('0.01');
  for (const [token, buy, sell] of candidates) {
    const [ref] = await four.discover(ctx, token);
    if (!ref) continue;
    const [out] = await four.quote(ctx, ref, 'buy', [amountIn]);
    if (!out) continue;
    const info = await probeTax(ctx, four, ref, amountIn, out);
    return { info, buy, sell };
  }
  return null;
}

function check(r: NonNullable<Awaited<ReturnType<typeof measure>>>, maxShortBps: number) {
  expect(r.info, 'probe').not.toBeNull();
  const info = r.info!;
  expect(info.sellFails).toBe(false);
  // What arrived matches the quote: the tax is in it, not taken on top.
  expect(info.transfer.buyBps).toBeLessThan(maxShortBps);
  expect(info.transfer.sellBps ?? 0).toBeLessThan(maxShortBps);
  expect(info.venue).toEqual({
    buyBps: FEE_BPS + r.buy * 100,
    sellBps: FEE_BPS + r.sell * 100,
  });
}

describe('four.meme tax tokens on their curve (mainnet simulation, no funds)', () => {
  it('quoted in BNB', async (t) => {
    const r = await measure(CANDIDATES);
    if (!r) return t.skip();
    check(r, 10);
  });

  // The helper's own swap into the asset lands a little under the leg's quote (taxed or
  // not, ~0.1%).
  it('quoted in a BEP-20', async (t) => {
    const r = await measure(VIA_ASSET);
    if (!r) return t.skip();
    check(r, 50);
  });
});
