import { describe, expect, it } from 'vitest';
import { feedPairs, mainPair, type FeedPair, type ListedPair } from '../src/shared/main-pair';

const TOKEN = '0xAbC0000000000000000000000000000000000001';
const OTHER = '0xdEF0000000000000000000000000000000000002';

const listed = (over: Partial<ListedPair> = {}): ListedPair => ({
  baseToken: { address: TOKEN },
  ...over,
});
const busy = (h1: number, h6 = 0, h24 = 0) => ({
  h1: { buys: h1, sells: 0 },
  h6: { buys: h6, sells: 0 },
  h24: { buys: h24, sells: 0 },
});

describe('mainPair', () => {
  it('takes the deepest pair of the token, whatever case its address is in', () => {
    const thin = listed({ liquidity: { usd: 5 } });
    const deep = listed({
      baseToken: { address: TOKEN.toLowerCase() },
      liquidity: { usd: 9 },
    });
    const elsewhere = listed({ baseToken: { address: OTHER }, liquidity: { usd: 99 } });
    expect(mainPair([thin, elsewhere, deep], TOKEN)).toBe(deep);
  });

  it('keeps the first of two equally deep pairs', () => {
    const a = listed({ liquidity: { usd: 5 } });
    const b = listed({ liquidity: { usd: 5 } });
    expect(mainPair([a, b], TOKEN)).toBe(a);
  });

  it('lets a busier pair with no liquidity figure take over', () => {
    const deep = listed({ dexId: 'meteora', liquidity: { usd: 42 }, txns: busy(1) });
    const unpriced = listed({ dexId: 'pumpswap', txns: busy(30) });
    expect(mainPair([deep, unpriced], TOKEN)).toBe(unpriced);
  });

  it('compares trades over the hour, then six hours, then the day', () => {
    const deep = listed({ liquidity: { usd: 42 }, txns: busy(2, 5, 9) });
    expect(mainPair([deep, listed({ txns: busy(2, 6, 0) })], TOKEN)).not.toBe(deep);
    expect(mainPair([deep, listed({ txns: busy(2, 4, 99) })], TOKEN)).toBe(deep);
    expect(mainPair([deep, listed({ txns: busy(2, 5, 9) })], TOKEN)).toBe(deep);
  });

  it('never lets a curve with no figure take over', () => {
    const deep = listed({ liquidity: { usd: 42 }, txns: busy(1) });
    const curve = listed({ dexId: 'pumpfun', txns: busy(500) });
    expect(mainPair([deep, curve], TOKEN)).toBe(deep);
  });

  it('holds an unpriced pool back until it trades more than the curve too', () => {
    const curve = listed({ dexId: 'pumpfun', txns: busy(10) });
    const quiet = listed({ dexId: 'pumpswap', txns: busy(3) });
    const loud = listed({ dexId: 'pumpswap', txns: busy(30) });
    expect(mainPair([curve, quiet], TOKEN)).toBe(curve);
    expect(mainPair([curve, loud], TOKEN)).toBe(loud);
  });

  it('has none for a token with no pair', () => {
    expect(mainPair([listed({ baseToken: { address: OTHER } })], TOKEN)).toBeNull();
  });
});

describe('feedPairs', () => {
  const lower = (address: string) => address.toLowerCase();
  const coin = TOKEN.toLowerCase();
  const pair = (over: FeedPair = {}): FeedPair => ({
    baseToken: { address: TOKEN },
    priceUsd: '2',
    ...over,
  });

  it('reads the pairs from either form of answer', () => {
    expect(feedPairs([pair()], [coin], lower).get(coin)?.priceUsd).toBe(2);
    expect(feedPairs({ pairs: [pair()] }, [coin], lower).get(coin)?.priceUsd).toBe(2);
    expect(feedPairs('nonsense', [coin], lower).size).toBe(0);
    expect(feedPairs(null, [coin], lower).size).toBe(0);
  });

  it('picks as the site does among the pairs with a price', () => {
    const thin = pair({ priceUsd: '1', dexId: 'meteora', liquidity: { usd: 42 }, txns: busy(1) });
    const busier = pair({ priceUsd: '3', dexId: 'pumpswap', txns: busy(30) });
    expect(feedPairs([thin, busier], [coin], lower).get(coin)?.feed).toBe(busier);
  });

  it('leaves out a pair with no price, however busy', () => {
    const priced = pair({ priceUsd: '1', liquidity: { usd: 42 } });
    const unpriced = pair({ priceUsd: undefined, dexId: 'pumpswap', txns: busy(30) });
    expect(feedPairs([priced, unpriced], [coin], lower).get(coin)?.feed).toBe(priced);
  });

  it('skips what is not an asked-for coin', () => {
    const answer = [
      null,
      pair({ baseToken: { address: OTHER } }),
      pair({ baseToken: { address: 7 } }),
      pair({ baseToken: {} }),
      {},
    ];
    expect(feedPairs(answer, [coin], lower).size).toBe(0);
    expect(feedPairs([pair()], [coin], () => null).size).toBe(0);
  });

  it('reads through nonsense in a pair', () => {
    const odd = pair({
      dexId: 7,
      liquidity: { usd: 'deep' },
      txns: { h1: null, h6: { buys: 'many', sells: Infinity }, h24: 'x' },
    });
    const none = pair({ txns: 'busy' });
    const found = feedPairs([odd, none], [coin], lower).get(coin);
    expect(found?.feed).toBe(odd);
    expect(found?.liquidity).toBeUndefined();
    expect(found?.dexId).toBeUndefined();
  });
});
