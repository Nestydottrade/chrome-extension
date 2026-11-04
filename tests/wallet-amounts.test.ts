import { describe, expect, it } from 'vitest';
import { walletAmounts } from '../src/background/trade/engine/core';

describe('walletAmounts', () => {
  it('gives every wallet the same amount without a variance', () => {
    expect(walletAmounts(1_000n, 3, 0)).toEqual([1_000n, 1_000n, 1_000n]);
  });

  it('buys exactly the amount with one wallet, whatever the variance', () => {
    expect(walletAmounts(1_000n, 1, 2_000, () => 0.99)).toEqual([1_000n]);
  });

  it('takes up to the variance off each wallet, never adding to it', () => {
    const draws = [0, 0.5, 0.999_999];
    let n = 0;
    // Nothing, 10% and 20% off.
    expect(walletAmounts(10_000n, 3, 2_000, () => draws[n++] as number)).toEqual([
      10_000n,
      9_000n,
      8_000n,
    ]);
  });

  it('stays between the amount and the variance below it', () => {
    for (const a of walletAmounts(1_000_000n, 500, 1_000)) {
      expect(a).toBeLessThanOrEqual(1_000_000n);
      expect(a).toBeGreaterThanOrEqual(900_000n);
    }
  });
});
