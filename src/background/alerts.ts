import {
  MAX_ALERTS,
  alertDue,
  alertNoteId,
  alertSlug,
  alertSymbol,
  alertText,
  alertToken,
  pricesFromFeed,
  type AlertInput,
  type AlertView,
  type PriceAlert,
} from '../shared/alerts';

const KEY = 'nesty.alerts';
/** Up to 30 coins of one chain per request. */
const FEED = 'https://api.dexscreener.com/tokens/v1';
const BATCH = 30;

export class AlertError extends Error {
  constructor(readonly code: 'too_many_alerts' | 'invalid_request' | 'unsupported_chain') {
    super(code);
    this.name = 'AlertError';
  }
}

export interface AlertDeps {
  local: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  fetchJson: (url: string) => Promise<unknown>;
  /** Shows a notification; its id comes back when it is clicked. */
  notify: (id: string, title: string, message: string) => Promise<void>;
  /** The browser does not show this extension's notifications. */
  blocked: () => Promise<boolean>;
  /** Keeps the prices read on a timer while there are alerts, and stops it when none are left. */
  schedule: (on: boolean) => Promise<void>;
  newId: () => string;
  now: () => number;
}

const keyOf = (chainId: number, token: string) => `${chainId}:${token}`;

const isAlert = (v: unknown): v is PriceAlert => {
  const a = v as Partial<PriceAlert> | null;
  return (
    typeof a?.id === 'string' &&
    typeof a.origin === 'string' &&
    typeof a.chainId === 'number' &&
    typeof a.token === 'string' &&
    typeof a.symbol === 'string' &&
    typeof a.above === 'boolean' &&
    typeof a.price === 'number' &&
    (a.supply === null || typeof a.supply === 'number')
  );
};

/**
 * Keeps the site's price alerts and reads their coins' prices, every 30 seconds while the
 * browser runs (an alarm wakes the worker for it); an alert whose price is reached shows a
 * notification and is removed.
 */
export class AlertWatcher {
  private cache: PriceAlert[] | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** The latest price read per coin (null: the feed had none), and when. */
  private readonly seen = new Map<string, { price: number | null; at: number }>();
  private checking: Promise<void> | null = null;
  private again = false;

  constructor(private readonly d: AlertDeps) {}

  private async alerts(): Promise<PriceAlert[]> {
    if (!this.cache) {
      const v = await this.d.local.get(KEY);
      this.cache = Array.isArray(v) ? v.filter(isAlert) : [];
    }
    return this.cache;
  }

  /** Serialised read-modify-write; the timer runs while any alert is left. */
  private write(fn: (list: PriceAlert[]) => PriceAlert[]): Promise<void> {
    const run = this.queue.then(async () => {
      const before = await this.alerts();
      const next = fn([...before]);
      this.cache = next;
      await this.d.local.set(KEY, next);
      if (before.length > 0 !== next.length > 0)
        await this.d.schedule(next.length > 0).catch(() => undefined);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private view(a: PriceAlert): AlertView {
    const s = this.seen.get(keyOf(a.chainId, a.token));
    return {
      id: a.id,
      chainId: a.chainId,
      token: a.token,
      symbol: a.symbol,
      above: a.above,
      price: a.price,
      supply: a.supply,
      at: a.at,
      now: s?.price ?? null,
      checkedAt: s?.at ?? null,
    };
  }

  /** When the worker starts: the timer runs while there are alerts, and their prices are read. */
  async start(): Promise<void> {
    const list = await this.alerts();
    await this.d.schedule(list.length > 0);
    if (list.length > 0) await this.check();
  }

  /** The alerts a site set. */
  async list(origin: string): Promise<AlertView[]> {
    return (await this.alerts()).filter((a) => a.origin === origin).map((a) => this.view(a));
  }

  blocked(): Promise<boolean> {
    return this.d.blocked();
  }

  async add(origin: string, input: AlertInput): Promise<AlertView> {
    if (!alertSlug(input.chainId)) throw new AlertError('unsupported_chain');
    const token = alertToken(input.chainId, input.token);
    const ok = (n: number) => Number.isFinite(n) && n > 0;
    if (!token || !ok(input.price) || (input.supply !== undefined && !ok(input.supply)))
      throw new AlertError('invalid_request');
    const alert: PriceAlert = {
      id: this.d.newId(),
      origin,
      chainId: input.chainId,
      token,
      symbol: alertSymbol(input.symbol),
      above: input.above,
      price: input.price,
      supply: input.supply ?? null,
      at: this.d.now(),
    };
    let kept: PriceAlert = alert;
    let full = false;
    await this.write((list) => {
      // The same alert twice (a double click) is kept once.
      const twin = list.find(
        (a) =>
          a.origin === origin &&
          a.chainId === alert.chainId &&
          a.token === token &&
          a.above === alert.above &&
          a.price === alert.price,
      );
      if (twin) {
        kept = twin;
        return list;
      }
      if (list.length >= MAX_ALERTS) {
        full = true;
        return list;
      }
      return [...list, alert];
    });
    if (full) throw new AlertError('too_many_alerts');
    // Its coin's price is read now, so the site can show it is followed.
    void this.check().catch(() => undefined);
    return this.view(kept);
  }

  async remove(origin: string, id: string): Promise<void> {
    await this.write((list) => list.filter((a) => !(a.id === id && a.origin === origin)));
  }

  /** Every alert a site set: when it is disconnected. */
  async removeSite(origin: string): Promise<void> {
    await this.write((list) => list.filter((a) => a.origin !== origin));
  }

  /** Reads the prices and fires the alerts they reach. Asked for during a check, another follows it. */
  check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again);
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private async run(): Promise<void> {
    const list = await this.alerts();
    const byChain = new Map<number, string[]>();
    for (const a of list) {
      const tokens = byChain.get(a.chainId) ?? [];
      if (!tokens.includes(a.token)) tokens.push(a.token);
      byChain.set(a.chainId, tokens);
    }
    // Coins no alert follows any more are forgotten.
    for (const k of [...this.seen.keys()])
      if (!list.some((a) => keyOf(a.chainId, a.token) === k)) this.seen.delete(k);
    if (list.length === 0) return;

    const prices = new Map<string, number>();
    await Promise.all(
      [...byChain].map(async ([chainId, tokens]) => {
        const slug = alertSlug(chainId);
        if (!slug) return;
        for (let i = 0; i < tokens.length; i += BATCH) {
          const batch = tokens.slice(i, i + BATCH);
          let json: unknown;
          try {
            json = await this.d.fetchJson(`${FEED}/${slug}/${batch.join(',')}`);
          } catch {
            json = null;
          }
          // No answer (or a refusal, such as a rate limit): these coins are asked for again next time.
          if (json === null || json === undefined) continue;
          const found = pricesFromFeed(chainId, batch, json);
          const at = this.d.now();
          for (const t of batch) {
            const price = found.get(t) ?? null;
            this.seen.set(keyOf(chainId, t), { price, at });
            if (price !== null) prices.set(keyOf(chainId, t), price);
          }
        }
      }),
    );

    const priceOf = (a: PriceAlert) => prices.get(keyOf(a.chainId, a.token));
    const due = (a: PriceAlert) => {
      const p = priceOf(a);
      return p !== undefined && alertDue(a, p);
    };
    if (!list.some(due)) return;
    // Removed first, so a notification is never shown twice for one alert.
    const fired: PriceAlert[] = [];
    await this.write((all) =>
      all.filter((a) => {
        if (!due(a)) return true;
        fired.push(a);
        return false;
      }),
    );
    for (const a of fired) {
      const { title, message } = alertText(a, priceOf(a) as number);
      await this.d.notify(alertNoteId(a), title, message).catch(() => undefined);
    }
  }
}
