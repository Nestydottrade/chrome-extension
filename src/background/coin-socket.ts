// A small JSON-RPC socket that hears a coin trade: on an EVM node, the token's Transfer logs
// (eth_subscribe); on a Solana node, the changes of the account its trades change, its curve or
// its pool (accountSubscribe). It tells only that the coin traded: prices are still read over
// HTTPS, the one path every venue is priced on.
//
// Private RPC: not Solana logs, as publicnode's socket takes logsSubscribe and at times sends
// no logs at all, while account changes keep coming (checked 2026-11-16).
//
// Not viem's socket: viem shares one socket per URL and keeps it open when its subscriptions
// end. This one closes when the panel stops watching, so the worker can sleep.

/** The node's dialect. */
export type SocketKind = 'evm' | 'solana';

/** The parts of a WebSocket this uses, so tests can pass their own. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type OpenSocket = (url: string) => SocketLike;

/** ERC-20 Transfer(address,address,uint256): every swap of the token moves some. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const OPEN = 1;

/**
 * How often an EVM socket is asked its block number, to know it still answers. Not a new-heads
 * subscription: Robinhood Chain makes about ten blocks a second, and its keyless socket counts
 * what it sends per IP. A Solana socket beats with each slot (about two a second).
 */
export const TICK_MS = 10_000;
/** No beat for this long and the socket no longer counts as live (two EVM beats missed). */
export const BEAT_STALE_MS = 30_000;
/** No beat for this long on an open socket, and it is opened again (a connection gone quiet). */
export const STUCK_MS = 45_000;
/** Waits between reconnects: doubled after each failure, up to the last. */
export const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const BEAT = 'beat';
const coinKey = (token: string) => `coin:${token}`;
const tokenOf = (key: string) => key.slice(5);

interface Dialect {
  /** The coin's subscription. */
  coin: (token: string) => { method: string; params: unknown[] };
  /** EVM: a request asked each tick. Solana: a subscription that beats each slot. */
  beat: { method: string; params: unknown[]; subscribed: boolean };
  /** The method the node's notices for `key` carry. */
  notice: (key: string) => string;
  unsubscribe: (key: string) => string;
}

const DIALECTS: Record<SocketKind, Dialect> = {
  evm: {
    coin: (token) => ({
      method: 'eth_subscribe',
      params: ['logs', { address: token, topics: [TRANSFER_TOPIC] }],
    }),
    beat: { method: 'eth_blockNumber', params: [], subscribed: false },
    notice: () => 'eth_subscription',
    unsubscribe: () => 'eth_unsubscribe',
  },
  // Solana numbers each kind of subscription on its own (a slot and an account subscription
  // can share an id), so notices are told apart by method too.
  solana: {
    coin: (account) => ({
      method: 'accountSubscribe',
      // Confirmed, as the quotes read: a change heard earlier could be read before it lands.
      params: [account, { commitment: 'confirmed', encoding: 'base64' }],
    }),
    beat: { method: 'slotSubscribe', params: [], subscribed: true },
    notice: (key) => (key === BEAT ? 'slotNotification' : 'accountNotification'),
    unsubscribe: (key) => (key === BEAT ? 'slotUnsubscribe' : 'accountUnsubscribe'),
  },
};

interface Coin {
  listeners: Set<() => void>;
  /** The node turned the subscription down on this connection. */
  refused: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const isSubId = (v: unknown): v is string | number =>
  typeof v === 'string' || typeof v === 'number';

export class CoinSocket {
  private ws: SocketLike | null = null;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wait = RETRY_FIRST_MS;
  private readonly ticker: ReturnType<typeof setInterval>;
  private openedAt = 0;
  private beatAt: number | null = null;
  private nextId = 1;
  /** Requests in flight on this connection, by id: a subscription's key, or a beat. */
  private readonly asked = new Map<number, string>();
  /** Subscriptions the node took, by the id of the request that asked. */
  private readonly taken = new Set<number>();
  /** Notices to subscriptions: `${method}:${subscription}` to the subscription's key. */
  private readonly routes = new Map<string, string>();
  /** The node's id of each subscription on this connection. */
  private readonly ids = new Map<string, string | number>();
  private readonly coins = new Map<string, Coin>();
  private readonly dialect: Dialect;

  constructor(
    private readonly url: string,
    kind: SocketKind,
    private readonly d: { now: () => number; open: OpenSocket },
  ) {
    this.dialect = DIALECTS[kind];
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.connect();
  }

  /**
   * Calls `listener` whenever the coin trades (once per notice): `target` is the token on an
   * EVM node, the account its trades change on a Solana one. Returns the stop.
   */
  watch(target: string, listener: () => void): () => void {
    let coin = this.coins.get(target);
    if (!coin) {
      coin = { listeners: new Set(), refused: false };
      this.coins.set(target, coin);
      if (this.isOpen()) this.ask(coinKey(target));
    }
    coin.listeners.add(listener);
    return () => {
      const c = this.coins.get(target);
      if (!c?.listeners.delete(listener) || c.listeners.size > 0) return;
      this.coins.delete(target);
      this.forget(coinKey(target));
    };
  }

  /** How many coins are watched. */
  size(): number {
    return this.coins.size;
  }

  /** Open, and the node keeps answering. */
  live(): boolean {
    return this.isOpen() && this.beatAt !== null && this.d.now() - this.beatAt <= BEAT_STALE_MS;
  }

  /** Live, and the node took the coin's subscription. */
  coinLive(target: string): boolean {
    const coin = this.coins.get(target);
    return coin !== undefined && !coin.refused && this.live();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.ticker);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
    this.coins.clear();
  }

  // ── the connection ────────────────────────────────────────────────────────

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    let ws: SocketLike;
    try {
      ws = this.d.open(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    this.openedAt = this.d.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedAt = this.d.now();
      this.ask(BEAT);
      for (const token of this.coins.keys()) this.ask(coinKey(token));
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.heard(ev.data);
    };
    // An error is followed by a close.
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.drop();
      this.retry();
    };
  }

  /** Lets go of the current connection and what was asked on it. */
  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.asked.clear();
    this.taken.clear();
    this.routes.clear();
    this.ids.clear();
    this.beatAt = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.wait);
    this.wait = Math.min(this.wait * 2, RETRY_MAX_MS);
  }

  private reopen(): void {
    this.drop();
    this.retry();
  }

  private tick(): void {
    if (!this.isOpen()) return;
    // Open but silent this long: likely dead without knowing it.
    if (this.d.now() - (this.beatAt ?? this.openedAt) >= STUCK_MS) {
      this.reopen();
      return;
    }
    if (!this.dialect.beat.subscribed) this.ask(BEAT);
  }

  // ── requests and notices ──────────────────────────────────────────────────

  private send(body: Json): void {
    try {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', ...body }));
    } catch {
      // Closing: the reconnect asks again.
    }
  }

  private ask(key: string): void {
    const id = this.nextId++;
    this.asked.set(id, key);
    const call = key === BEAT ? this.dialect.beat : this.dialect.coin(tokenOf(key));
    if (key !== BEAT) {
      const coin = this.coins.get(tokenOf(key));
      if (coin) coin.refused = false;
    }
    this.send({ id, method: call.method, params: call.params });
  }

  /** Ends a subscription the node gave (one still in flight is ended when its answer comes). */
  private forget(key: string): void {
    const sub = this.ids.get(key);
    if (sub === undefined) return;
    this.ids.delete(key);
    this.routes.delete(`${this.dialect.notice(key)}:${String(sub)}`);
    this.unsubscribe(key, sub);
  }

  private unsubscribe(key: string, sub: string | number): void {
    this.send({ id: this.nextId++, method: this.dialect.unsubscribe(key), params: [sub] });
  }

  private heard(data: unknown): void {
    let m: unknown;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (typeof m.id === 'number') {
      this.answered(m.id, m);
      return;
    }
    const params = m.params;
    if (typeof m.method !== 'string' || !isObj(params)) return;
    const key = this.routes.get(`${m.method}:${String(params.subscription)}`);
    if (key === undefined) return;
    if (key === BEAT) {
      this.beat();
      return;
    }
    const coin = this.coins.get(tokenOf(key));
    if (coin) for (const listener of [...coin.listeners]) listener();
  }

  private beat(): void {
    this.beatAt = this.d.now();
    this.wait = RETRY_FIRST_MS;
  }

  private answered(id: number, m: Json): void {
    const key = this.asked.get(id);
    if (key === undefined) {
      // An error long after the answer: the node let the subscription go and the socket stays
      // open and silent (publicnode did so on Base). Only a new connection hears on.
      if (m.error !== undefined && this.taken.has(id)) this.reopen();
      return;
    }
    this.asked.delete(id);
    if (key === BEAT && !this.dialect.beat.subscribed) {
      if (m.error === undefined && m.result !== undefined) this.beat();
      return;
    }
    const sub = m.result;
    if (m.error !== undefined || !isSubId(sub)) {
      const coin = key === BEAT ? undefined : this.coins.get(tokenOf(key));
      if (coin) coin.refused = true;
      return;
    }
    this.taken.add(id);
    // Asked twice (stopped and watched again meanwhile): one subscription is enough.
    if (this.ids.has(key)) {
      this.unsubscribe(key, sub);
      return;
    }
    this.ids.set(key, sub);
    this.routes.set(`${this.dialect.notice(key)}:${String(sub)}`, key);
    // Stopped while the answer was on its way.
    if (key !== BEAT && !this.coins.has(tokenOf(key))) this.forget(key);
  }
}
