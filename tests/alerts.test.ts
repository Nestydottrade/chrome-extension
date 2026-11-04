import { describe, expect, it } from 'vitest';
import { AlertError, AlertWatcher, type AlertDeps } from '../src/background/alerts';
import {
  MAX_ALERTS,
  alertPage,
  alertText,
  pricesFromFeed,
  type AlertInput,
  type PriceAlert,
} from '../src/shared/alerts';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const SITE = 'http://localhost:5173';
const OTHER = 'http://127.0.0.1:5173';
const BASE = 8453;
// Made up for the tests: no real coin's addresses.
const MINT = 'Coin1111111111111111111111111111111111111111';
const TOKEN = '0x00000000000000000000000000000000000070C0';
const TOKEN_LC = TOKEN.toLowerCase();
const OTHER_TOKEN = '0x00000000000000000000000000000000000070c1';

class Memory {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
}

const pair = (address: string, priceUsd: string, liquidity = 1_000) => ({
  baseToken: { address },
  priceUsd,
  liquidity: { usd: liquidity },
});

/** `feed` answers each price request; the default lists nothing. */
function setup(feed: (url: string) => unknown = () => []) {
  let n = 0;
  let t = 1_000;
  const notes: { id: string; title: string; message: string }[] = [];
  const scheduled: boolean[] = [];
  const urls: string[] = [];
  const d: AlertDeps = {
    local: new Memory(),
    fetchJson: async (url) => {
      urls.push(url);
      return feed(url);
    },
    notify: async (id, title, message) => {
      notes.push({ id, title, message });
    },
    blocked: async () => false,
    schedule: async (on) => {
      scheduled.push(on);
    },
    newId: () => `a${++n}`,
    now: () => t,
  };
  const w = new AlertWatcher(d);
  return { w, notes, scheduled, urls, tick: (ms: number) => (t += ms) };
}

const onBase = (over: Partial<AlertInput> = {}): AlertInput => ({
  chainId: BASE,
  token: TOKEN,
  symbol: 'DEGEN',
  above: true,
  price: 0.01,
  ...over,
});

describe('price alerts', () => {
  it('keeps each site its own alerts, the coin as its chain writes it', async () => {
    const { w, scheduled } = setup();
    const a = await w.add(SITE, onBase({ symbol: ' DE‮GEN\u0000 ' }));
    expect(a).toMatchObject({
      token: TOKEN_LC,
      symbol: 'DEGEN',
      above: true,
      price: 0.01,
      supply: null,
    });
    expect((await w.list(SITE)).map((x) => x.id)).toEqual([a.id]);
    expect(await w.list(OTHER)).toEqual([]);
    // The timer starts with the first alert.
    expect(scheduled).toEqual([true]);
  });

  it('turns down what is no coin of its chain, a chain without prices, and no price', async () => {
    const { w } = setup();
    await expect(w.add(SITE, onBase({ chainId: SOLANA_CHAIN_ID }))).rejects.toEqual(
      new AlertError('invalid_request'),
    );
    await expect(w.add(SITE, onBase({ token: MINT }))).rejects.toEqual(
      new AlertError('invalid_request'),
    );
    await expect(w.add(SITE, onBase({ chainId: 999_999 }))).rejects.toEqual(
      new AlertError('unsupported_chain'),
    );
    await expect(w.add(SITE, onBase({ price: 0 }))).rejects.toEqual(
      new AlertError('invalid_request'),
    );
    await expect(w.add(SITE, onBase({ supply: Number.NaN }))).rejects.toEqual(
      new AlertError('invalid_request'),
    );
    expect(await w.list(SITE)).toEqual([]);
  });

  it('keeps the same alert once, and no more alerts than the cap', async () => {
    const { w } = setup();
    const a = await w.add(SITE, onBase());
    const again = await w.add(SITE, onBase());
    expect(again.id).toBe(a.id);
    for (let i = 1; i < MAX_ALERTS; i++) await w.add(SITE, onBase({ price: 0.01 + i / 1000 }));
    expect(await w.list(SITE)).toHaveLength(MAX_ALERTS);
    await expect(w.add(SITE, onBase({ price: 5 }))).rejects.toEqual(
      new AlertError('too_many_alerts'),
    );
  });

  it('fires an alert once its price is reached, then forgets it', async () => {
    let price = '0.009';
    const { w, notes, scheduled } = setup(() => [pair(TOKEN, price)]);
    const up = await w.add(SITE, onBase());
    await w.check();
    expect(notes).toEqual([]);
    const [seen] = await w.list(SITE);
    expect(seen).toMatchObject({ id: up.id, now: 0.009 });
    expect(seen?.checkedAt).not.toBeNull();

    price = '0.0101';
    await w.check();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('DEGEN rose to $0.01');
    expect(notes[0]?.message).toBe('Price now $0.0101. Click to open the coin.');
    expect(alertPage(notes[0]?.id ?? '')).toBe(`${SITE}/#/token/base/${TOKEN_LC}`);
    expect(await w.list(SITE)).toEqual([]);
    // Once none is left, the timer stops.
    expect(scheduled).toEqual([true, false]);

    // Never twice.
    await w.check();
    expect(notes).toHaveLength(1);
  });

  it('fires a falling alert at or below its price, on Solana too', async () => {
    let price = '0.0003';
    const { w, notes } = setup((url) => (url.includes('/solana/') ? [pair(MINT, price)] : []));
    await w.add(SITE, {
      chainId: SOLANA_CHAIN_ID,
      token: MINT,
      symbol: 'COIN',
      above: false,
      price: 0.0002,
    });
    await w.check();
    expect(notes).toEqual([]);
    price = '0.0002';
    await w.check();
    // Tiny prices as the site writes them: 0.0002 is 0.0₃2.
    expect(notes.map((n) => n.title)).toEqual(['COIN fell to $0.0₃2']);
    expect(alertPage(notes[0]?.id ?? '')).toBe(`${SITE}/#/token/solana/${MINT}`);
  });

  it('asks for each chain’s coins together, and takes the most liquid pair’s price', async () => {
    const { w, urls } = setup((url) =>
      url.includes('/base/')
        ? [
            pair(TOKEN, '1', 50),
            pair(TOKEN, '2', 5_000),
            pair(OTHER_TOKEN, '3'),
            // The coin as the quote of another's pair says nothing of its price.
            { baseToken: { address: '0x0000000000000000000000000000000000000001' }, priceUsd: '9' },
          ]
        : [pair(MINT, '0.5')],
    );
    await w.add(SITE, onBase({ price: 10 }));
    await w.add(SITE, onBase({ token: OTHER_TOKEN, price: 10 }));
    await w.add(SITE, {
      chainId: SOLANA_CHAIN_ID,
      token: MINT,
      symbol: 'COIN',
      above: true,
      price: 1,
    });
    // Each add reads its coin's price at once: wait for those first.
    await w.check();
    urls.length = 0;
    await w.check();
    expect(urls.sort()).toEqual([
      `https://api.dexscreener.com/tokens/v1/base/${TOKEN_LC},${OTHER_TOKEN}`,
      `https://api.dexscreener.com/tokens/v1/solana/${MINT}`,
    ]);
    const now = Object.fromEntries((await w.list(SITE)).map((a) => [a.token, a.now]));
    expect(now).toEqual({ [TOKEN_LC]: 2, [OTHER_TOKEN]: 3, [MINT]: 0.5 });
  });

  it('says when no price was found, and asks again when the feed does not answer', async () => {
    let answer: unknown = null;
    const { w } = setup(() => answer);
    await w.add(SITE, onBase());
    await w.check();
    // Refused (a rate limit reads as null): nothing is known yet.
    expect((await w.list(SITE))[0]).toMatchObject({ now: null, checkedAt: null });
    answer = [];
    await w.check();
    const [a] = await w.list(SITE);
    expect(a?.now).toBeNull();
    expect(a?.checkedAt).not.toBeNull();
  });

  it('says the market cap when the alert was given as one', () => {
    const a: PriceAlert = {
      id: 'a1',
      origin: SITE,
      chainId: SOLANA_CHAIN_ID,
      token: MINT,
      symbol: 'COIN',
      above: true,
      price: 0.002,
      supply: 1_000_000_000,
      at: 0,
    };
    expect(alertText(a, 0.0021)).toEqual({
      title: 'COIN rose to $2M market cap',
      message: 'Market cap now $2.1M. Click to open the coin.',
    });
  });

  it('opens only a coin page of the Nesty site', () => {
    const page = (origin: string, token = TOKEN_LC, chain = String(BASE)) =>
      alertPage(['alert', 'a1', chain, token, origin].join('|'));
    expect(page(SITE)).toBe(`${SITE}/#/token/base/${TOKEN_LC}`);
    expect(page('https://evil.example')).toBeNull();
    expect(page(SITE, '0xnot-an-address')).toBeNull();
    // Kept in lower case: anything else was not written by the watcher.
    expect(page(SITE, TOKEN)).toBeNull();
    expect(page(SITE, TOKEN_LC, '999999')).toBeNull();
    expect(alertPage('some-other-notification')).toBeNull();
    expect(alertPage(`alert|a1|${BASE}|${TOKEN_LC}|${SITE}|extra`)).toBeNull();
  });

  it('drops a site’s alerts when it is disconnected, and only its own', async () => {
    const { w } = setup();
    await w.add(SITE, onBase());
    const kept = await w.add(OTHER, onBase());
    await w.removeSite(SITE);
    expect(await w.list(SITE)).toEqual([]);
    expect((await w.list(OTHER)).map((a) => a.id)).toEqual([kept.id]);
  });

  it('reads prices only from pairs that hold together', () => {
    const found = pricesFromFeed(
      BASE,
      [TOKEN_LC],
      [
        null,
        { baseToken: { address: 7 }, priceUsd: '1' },
        pair(TOKEN, 'NaN'),
        pair(TOKEN, '-1'),
        pair(TOKEN, '0.25'),
      ],
    );
    expect([...found]).toEqual([[TOKEN_LC, 0.25]]);
    expect(pricesFromFeed(BASE, [TOKEN_LC], { pairs: [pair(TOKEN, '4')] }).get(TOKEN_LC)).toBe(4);
    expect(pricesFromFeed(BASE, [TOKEN_LC], 'nonsense').size).toBe(0);
  });
});
