import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BEAT_STALE_MS,
  CoinSocket,
  RETRY_FIRST_MS,
  STUCK_MS,
  TICK_MS,
  type SocketLike,
} from '../src/background/coin-socket';
import { CoinWatch, IDLE_CLOSE_MS, LEASE_MS, NOTIFY_GAP_MS } from '../src/background/coin-watch';
import { handleMessage, type RouterDeps } from '../src/background/router';
import { bondingCurveAddress } from '../src/background/solana/pump';
import { marketAccount, type SolRoute } from '../src/background/solana/routes';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const COIN_A = '0x00000000000000000000000000000000000000aa';
const COIN_B = '0x00000000000000000000000000000000000000bb';
const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const CURVE = 'Curve1111111111111111111111111111111111111';
const VAULT = 'Vau1t11111111111111111111111111111111111111';

type Sent = { id: number; method: string; params: unknown[] };

/** A socket the test opens, answers and drops by hand (block numbers it answers itself). */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  static autoBeat = true;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Sent[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    const m = JSON.parse(data) as Sent;
    this.sent.push(m);
    if (FakeSocket.autoBeat && m.method === 'eth_blockNumber')
      this.reply({ id: m.id, result: '0x10' });
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', ...msg }) });
  }
  /** The server closes it. */
  lose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  asked(method: string): Sent[] {
    return this.sent.filter((m) => m.method === method);
  }
  /** The id of the last request asking `method`. */
  idOf(method: string): number {
    const m = this.asked(method).at(-1);
    if (!m) throw new Error(`nothing asked ${method}`);
    return m.id;
  }
}

const open = (url: string) => new FakeSocket(url);
const last = () => {
  const s = FakeSocket.all.at(-1);
  if (!s) throw new Error('no socket');
  return s;
};

/** An EVM socket opened, answering its beat and taking the coin as `sub`. */
function evmLive(socket: FakeSocket, sub = '0xs1') {
  socket.open();
  socket.reply({ id: socket.idOf('eth_blockNumber'), result: '0x10' });
  socket.reply({ id: socket.idOf('eth_subscribe'), result: sub });
}

const transfer = (socket: FakeSocket, sub: string) =>
  socket.reply({
    method: 'eth_subscription',
    params: { subscription: sub, result: { topics: [TRANSFER] } },
  });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  FakeSocket.autoBeat = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a coin socket on an EVM node', () => {
  it('hears the coin once the node takes its Transfer subscription', () => {
    FakeSocket.autoBeat = false;
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    const heard = vi.fn();
    s.watch(COIN_A, heard);
    const ws = last();
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.asked('eth_blockNumber')).toHaveLength(1);
    expect(ws.asked('eth_subscribe').map((m) => m.params)).toEqual([
      ['logs', { address: COIN_A, topics: [TRANSFER] }],
    ]);
    expect(s.live()).toBe(false);
    ws.reply({ id: ws.idOf('eth_blockNumber'), result: '0x10' });
    expect(s.live()).toBe(true);
    ws.reply({ id: ws.idOf('eth_subscribe'), result: '0xs1' });
    expect(s.coinLive(COIN_A)).toBe(true);
    transfer(ws, '0xs1');
    transfer(ws, '0xother');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('asks its block number each tick, and opens again when the node goes quiet', () => {
    FakeSocket.autoBeat = false;
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    s.watch(COIN_A, () => undefined);
    const first = last();
    evmLive(first);
    vi.advanceTimersByTime(TICK_MS);
    expect(first.asked('eth_blockNumber')).toHaveLength(2);
    // Unanswered: no longer live past the stale mark, reopened past the stuck one.
    vi.advanceTimersByTime(BEAT_STALE_MS - TICK_MS + 1);
    expect(s.live()).toBe(false);
    vi.advanceTimersByTime(STUCK_MS - BEAT_STALE_MS + TICK_MS);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(RETRY_FIRST_MS);
    const second = last();
    expect(second).not.toBe(first);
    second.open();
    expect(second.asked('eth_subscribe')).toHaveLength(1);
  });

  it('subscribes again after the server closes it', () => {
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    const heard = vi.fn();
    s.watch(COIN_A, heard);
    const first = last();
    evmLive(first);
    first.lose();
    expect(s.live()).toBe(false);
    vi.advanceTimersByTime(RETRY_FIRST_MS);
    const second = last();
    evmLive(second, '0xs2');
    transfer(second, '0xs2');
    // The old subscription's id means nothing on the new connection.
    transfer(second, '0xs1');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reopens when the node lets a taken subscription go with a late error', () => {
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    s.watch(COIN_A, () => undefined);
    const first = last();
    evmLive(first);
    first.reply({
      id: first.idOf('eth_subscribe'),
      error: { code: -32603, message: 'Internal error' },
    });
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(RETRY_FIRST_MS);
    expect(last()).not.toBe(first);
  });

  it('ends a stopped coin there too, even one stopped before its answer came', () => {
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    const stopA = s.watch(COIN_A, () => undefined);
    const ws = last();
    evmLive(ws);
    stopA();
    expect(ws.asked('eth_unsubscribe').map((m) => m.params)).toEqual([['0xs1']]);
    expect(s.size()).toBe(0);

    const stopB = s.watch(COIN_B, () => undefined);
    const askedB = ws.idOf('eth_subscribe');
    stopB();
    ws.reply({ id: askedB, result: '0xs2' });
    expect(ws.asked('eth_unsubscribe').map((m) => m.params)).toEqual([['0xs1'], ['0xs2']]);
  });

  it('counts a refused coin as not heard while the socket stays live', () => {
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    s.watch(COIN_A, () => undefined);
    const ws = last();
    ws.open();
    ws.reply({ id: ws.idOf('eth_blockNumber'), result: '0x10' });
    ws.reply({ id: ws.idOf('eth_subscribe'), error: { code: -32000, message: 'no' } });
    expect(s.live()).toBe(true);
    expect(s.coinLive(COIN_A)).toBe(false);
    expect(ws.closed).toBe(false);
  });

  it('closes for good', () => {
    const s = new CoinSocket('wss://node.test', 'evm', { now: Date.now, open });
    const ws = last();
    ws.open();
    expect(s.live()).toBe(true);
    s.close();
    expect(ws.closed).toBe(true);
    vi.advanceTimersByTime(STUCK_MS * 2);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('a coin socket on a Solana node', () => {
  it("hears the coin's account change, telling it from slots by method", () => {
    const s = new CoinSocket('wss://sol.test', 'solana', { now: Date.now, open });
    const heard = vi.fn();
    s.watch(CURVE, heard);
    const ws = last();
    ws.open();
    expect(ws.asked('accountSubscribe').map((m) => m.params)).toEqual([
      [CURVE, { commitment: 'confirmed', encoding: 'base64' }],
    ]);
    // Both subscriptions numbered 0, as Solana nodes may.
    ws.reply({ id: ws.idOf('slotSubscribe'), result: 0 });
    ws.reply({ id: ws.idOf('accountSubscribe'), result: 0 });
    ws.reply({ method: 'slotNotification', params: { subscription: 0, result: { slot: 1 } } });
    expect(s.coinLive(CURVE)).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    ws.reply({
      method: 'accountNotification',
      params: {
        subscription: 0,
        result: { context: { slot: 2 }, value: { data: ['', 'base64'] } },
      },
    });
    expect(heard).toHaveBeenCalledTimes(1);
    // Slots beat on their own: nothing is asked each tick.
    vi.advanceTimersByTime(TICK_MS);
    expect(ws.asked('slotSubscribe')).toHaveLength(1);
    s.watch(CURVE, heard)();
    expect(ws.asked('accountUnsubscribe').map((m) => m.params)).toEqual([[0]]);
  });

  it("picks the account a route's trades change", () => {
    const pump = (hop: Record<string, unknown>) =>
      ({
        kind: 'pump',
        pump: { hops: [{ kind: 'curve', mint: 'Other' }, hop] },
      }) as unknown as SolRoute;
    expect(marketAccount(pump({ kind: 'curve', mint: MINT }))).toBe(bondingCurveAddress(MINT));
    expect(
      marketAccount(pump({ kind: 'pool', mint: MINT, pool: { poolBaseTokenAccount: VAULT } })),
    ).toBe(VAULT);
    expect(marketAccount({ kind: 'dex', dex: 'orca', pool: 'Pool' } as unknown as SolRoute)).toBe(
      'Pool',
    );
    expect(marketAccount({ kind: 'pump', pump: { hops: [] } } as unknown as SolRoute)).toBeNull();
  });
});

describe('the coin watch', () => {
  function watcher(urls: Record<number, string> = { 56: 'wss://bnb.test' }) {
    const told: [number, number, string][] = [];
    const targets = new Map<string, string | null>();
    const w = new CoinWatch({
      now: Date.now,
      open,
      socketUrl: async (chainId) => urls[chainId] ?? '',
      kindOf: (chainId) => (chainId === SOLANA_CHAIN_ID ? 'solana' : 'evm'),
      targetOf: async (_chainId, token) =>
        targets.has(token) ? (targets.get(token) ?? null) : token.toLowerCase(),
      notify: (tabId, chainId, token) => told.push([tabId, chainId, token]),
    });
    return { w, told, urls, targets };
  }

  it('renews one watch per tab without subscribing again', async () => {
    const { w } = watcher();
    expect(await w.watch(1, 56, COIN_A.toUpperCase().replace('0X', '0x'))).toEqual({ live: false });
    const ws = last();
    evmLive(ws);
    expect(await w.watch(1, 56, COIN_A)).toEqual({ live: true });
    expect(ws.asked('eth_subscribe')).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('moves a tab to its new coin, subscribing it before letting the old one go', async () => {
    const { w } = watcher();
    await w.watch(1, 56, COIN_A);
    const ws = last();
    evmLive(ws);
    await w.watch(1, 56, COIN_B);
    const addressOf = (m: Sent) => (m.params[1] as { address: string }).address;
    expect(ws.asked('eth_subscribe').map(addressOf)).toEqual([COIN_A, COIN_B]);
    expect(ws.asked('eth_unsubscribe').map((m) => m.params)).toEqual([['0xs1']]);
    const subscribedB = ws.sent.findIndex(
      (m) => m.method === 'eth_subscribe' && addressOf(m) === COIN_B,
    );
    expect(subscribedB).toBeLessThan(ws.sent.findIndex((m) => m.method === 'eth_unsubscribe'));
    // Renewed while shown: the socket stays, and stays the only one.
    for (let i = 0; i < 24; i++) {
      vi.advanceTimersByTime(5_000);
      await w.watch(1, 56, COIN_B);
    }
    expect(ws.closed).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('tells a tab at most once a second, and a trade inside the second when it ends', async () => {
    const { w, told } = watcher();
    await w.watch(7, 56, COIN_A);
    const ws = last();
    evmLive(ws);
    transfer(ws, '0xs1');
    expect(told).toEqual([[7, 56, COIN_A]]);
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 10; i++) transfer(ws, '0xs1');
    expect(told).toHaveLength(1);
    vi.advanceTimersByTime(NOTIFY_GAP_MS - 300);
    expect(told).toHaveLength(2);
    vi.advanceTimersByTime(NOTIFY_GAP_MS * 3);
    expect(told).toHaveLength(2);
  });

  it('lets an unrenewed watch lapse, and closes the socket a minute after the last', async () => {
    const { w, told } = watcher();
    await w.watch(1, 56, COIN_A);
    const ws = last();
    evmLive(ws);
    vi.advanceTimersByTime(LEASE_MS + 5_000);
    expect(ws.asked('eth_unsubscribe')).toHaveLength(1);
    transfer(ws, '0xs1');
    expect(told).toEqual([]);
    expect(ws.closed).toBe(false);
    vi.advanceTimersByTime(IDLE_CLOSE_MS);
    expect(ws.closed).toBe(true);
  });

  it('keeps an idle socket for a watch that comes back within the minute', async () => {
    const { w } = watcher();
    await w.watch(1, 56, COIN_A);
    const ws = last();
    evmLive(ws);
    w.drop(1);
    vi.advanceTimersByTime(IDLE_CLOSE_MS / 2);
    await w.watch(2, 56, COIN_B);
    vi.advanceTimersByTime(IDLE_CLOSE_MS);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('opens nothing for a chain without a socket', async () => {
    const { w } = watcher();
    expect(await w.watch(1, 99901, COIN_A)).toEqual({ live: false });
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("moves a chain's watches to a new socket address", async () => {
    const { w, urls } = watcher();
    await w.watch(1, 56, COIN_A);
    const first = last();
    evmLive(first);
    urls[56] = 'wss://own.test';
    expect(await w.watch(1, 56, COIN_A)).toEqual({ live: false });
    expect(first.closed).toBe(true);
    const second = last();
    expect(second.url).toBe('wss://own.test');
    second.open();
    expect(second.asked('eth_subscribe')).toHaveLength(1);
  });

  it("moves a Solana coin's watch to its pool when it graduates", async () => {
    const SOL = SOLANA_CHAIN_ID;
    const { w, told, targets } = watcher({ [SOL]: 'wss://sol.test' });
    targets.set(MINT, CURVE);
    await w.watch(3, SOL, MINT);
    const ws = last();
    ws.open();
    ws.reply({ id: ws.idOf('accountSubscribe'), result: 5 });
    targets.set(MINT, VAULT);
    await w.watch(3, SOL, MINT);
    expect(ws.asked('accountSubscribe').map((m) => m.params[0])).toEqual([CURVE, VAULT]);
    expect(ws.asked('accountUnsubscribe').map((m) => m.params)).toEqual([[5]]);
    ws.reply({ id: ws.idOf('accountSubscribe'), result: 6 });
    ws.reply({ method: 'accountNotification', params: { subscription: 6, result: {} } });
    // The tab hears its coin, by its mint.
    expect(told).toEqual([[3, SOL, MINT]]);
    // Nothing trades it any more: no watch.
    targets.set(MINT, null);
    expect(await w.watch(3, SOL, MINT)).toEqual({ live: false });
    expect(ws.asked('accountUnsubscribe')).toHaveLength(2);
  });

  it('ends every watch when the wallet locks', async () => {
    const { w, told } = watcher();
    await w.watch(1, 56, COIN_A);
    await w.watch(2, 56, COIN_B);
    const ws = last();
    ws.open();
    ws.sent
      .filter((m) => m.method === 'eth_subscribe')
      .forEach((m, i) => ws.reply({ id: m.id, result: `0xs${i + 1}` }));
    w.clear();
    expect(ws.asked('eth_unsubscribe')).toHaveLength(2);
    transfer(ws, '0xs1');
    expect(told).toEqual([]);
  });
});

describe('the panel watch through the router', () => {
  function deps(unlocked: boolean) {
    const watch = vi.fn(async () => ({ live: true }));
    const drop = vi.fn();
    const onActivity = vi.fn(async () => undefined);
    const d = {
      vault: { isUnlocked: async () => unlocked },
      coinWatch: { watch, drop },
      onActivity,
    } as unknown as RouterDeps;
    return { d, watch, drop, onActivity };
  }
  const content = { kind: 'content-script', tabId: 4 } as const;
  const req = { type: 'panel.watch', chainId: 56, token: COIN_A };

  it("watches for the asking tab, and not as the user's activity", async () => {
    const { d, watch, onActivity } = deps(true);
    expect(await handleMessage(req, content, d)).toEqual({ ok: true, data: { live: true } });
    expect(watch).toHaveBeenCalledWith(4, 56, getAddress(COIN_A));
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('keeps the coin private while locked, and without a tab', async () => {
    const locked = deps(false);
    expect(await handleMessage(req, content, locked.d)).toEqual({
      ok: true,
      data: { live: false },
    });
    expect(locked.watch).not.toHaveBeenCalled();
    const open = deps(true);
    expect(await handleMessage(req, { kind: 'content-script' }, open.d)).toEqual({
      ok: true,
      data: { live: false },
    });
    expect(open.watch).not.toHaveBeenCalled();
  });

  it("refuses an address of another network, and drops the tab's watch", async () => {
    const { d, drop } = deps(true);
    expect(await handleMessage({ ...req, token: MINT }, content, d)).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(await handleMessage({ type: 'panel.unwatch' }, content, d)).toEqual({
      ok: true,
      data: null,
    });
    expect(drop).toHaveBeenCalledWith(4);
  });
});
