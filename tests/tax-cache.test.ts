import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Routed } from '../src/background/trade/routing';
import { TAX_RETRY_MS, TAX_TTL_MS, TaxService, type TaxInfo } from '../src/background/trade/tax';
import type { Venue, VenueCtx } from '../src/background/trade/types';
import { getChain } from '../src/shared/chains';

const TOKEN: Address = '0xe0Ab3A7A32ef7bBd2a5142D88a73020164a4aA57';
let now = 1_000_000;
const ctx: VenueCtx = { chain: getChain(4663)!, client: {} as never, now: () => now };

const venue: Venue = {
  id: 'pons',
  supports: () => true,
  discover: async () => [],
  quote: async (_c, _p, _s, amounts) => amounts.map(() => null),
  buildBuy: () => ({ to: TOKEN, data: '0x', value: 0n }),
  buildSell: () => ({ to: TOKEN, data: '0x', value: 0n }),
  sellApproval: () => ({ spender: TOKEN, viaPermit2: false, router: TOKEN }),
};
const route: Routed = {
  venue,
  pool: { venueId: 'pons', id: 'pons:curve', label: 'Pons curve', token: TOKEN, data: null },
  out: 1_000n,
};
/** A Pons curve's 1% fee and 1% creator tax, nothing taken on transfers. */
const measured: TaxInfo = {
  transfer: { buyBps: 0, sellBps: 0 },
  venue: { buyBps: 200, sellBps: 200 },
  sellFails: false,
};

describe('tax cache', () => {
  it('measures again soon after the RPC refused the probe', async () => {
    let calls = 0;
    const tax = new TaxService(undefined, async () => {
      calls++;
      if (calls === 1) throw new Error('429 Too Many Requests');
      return measured;
    });
    expect(await tax.get(ctx, route, 10n)).toBeNull();
    // Unknown for now, and not probed again on every refresh.
    expect(tax.peek(ctx, route)).toBeNull();
    expect(await tax.get(ctx, route, 10n)).toBeNull();
    expect(calls).toBe(1);
    now += TAX_RETRY_MS;
    expect(tax.peek(ctx, route)).toBeUndefined();
    expect(await tax.get(ctx, route, 10n)).toEqual(measured);
    expect(calls).toBe(2);
    // The measurement is kept for the full time.
    now += TAX_TTL_MS - 1;
    expect(tax.peek(ctx, route)).toEqual(measured);
    now += 1;
    expect(tax.peek(ctx, route)).toBeUndefined();
  });

  it('keeps a probe that ran but could not measure as long as a measurement', async () => {
    let calls = 0;
    const tax = new TaxService(undefined, async () => {
      calls++;
      // The simulated buy reverted.
      return null;
    });
    expect(await tax.get(ctx, route, 10n)).toBeNull();
    now += TAX_RETRY_MS;
    expect(tax.peek(ctx, route)).toBeNull();
    expect(await tax.get(ctx, route, 10n)).toBeNull();
    expect(calls).toBe(1);
    now += TAX_TTL_MS - TAX_RETRY_MS;
    expect(tax.peek(ctx, route)).toBeUndefined();
  });

  it('probes once for the asks made while a probe runs', async () => {
    let calls = 0;
    let release = () => {};
    const tax = new TaxService(undefined, () => {
      calls++;
      return new Promise<TaxInfo>((resolve) => {
        release = () => resolve(measured);
      });
    });
    const first = tax.get(ctx, route, 10n);
    const second = tax.get(ctx, route, 10n);
    release();
    expect(await first).toEqual(measured);
    expect(await second).toEqual(measured);
    expect(calls).toBe(1);
  });
});
