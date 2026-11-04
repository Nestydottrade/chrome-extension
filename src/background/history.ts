import type { TradeTicket } from '../shared/panel';
import type { KeyValueStore } from './vault/vault';

const KEY = 'nesty.history';
const MAX = 200;

/**
 * Whether any of the ticket's transactions went out to the network. A trade that Nesty's own
 * checks stopped before sending (too little balance, a blocked call, no route) left nothing
 * on chain to look back on, and its error was shown when it happened.
 */
export function reachedChain(t: TradeTicket): boolean {
  return t.legs.some((l) => l.hash !== undefined || l.sig !== undefined);
}

/**
 * Activity log: every ticket (buy, sell, bridge, transfer) that reached the chain, newest
 * first, the last `max` (200 unless the owner keeps more). Holds tx hashes, amounts and
 * wallet names only — no key material.
 */
export class HistoryStore {
  private cache: TradeTicket[] | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly local: KeyValueStore,
    private readonly max = MAX,
  ) {}

  async list(): Promise<TradeTicket[]> {
    if (!this.cache) {
      const v = await this.local.get(KEY);
      const saved = Array.isArray(v) ? (v as TradeTicket[]) : [];
      this.cache = saved.filter(reachedChain);
      // Saved tickets that never reached the chain leave storage too.
      if (this.cache.length < saved.length) void this.save().catch(() => undefined);
    }
    return this.cache;
  }

  /**
   * Inserts or replaces by id, once the ticket has reached the chain. Writes are serialised
   * so rapid updates do not race; a failed write (e.g. storage full) rejects only its own
   * call, never the ones after it.
   */
  upsert(ticket: TradeTicket): Promise<void> {
    if (!reachedChain(ticket)) return Promise.resolve();
    const run = this.queue.then(async () => {
      const list = [...(await this.list())];
      const i = list.findIndex((t) => t.id === ticket.id);
      if (i >= 0) list[i] = ticket;
      else list.unshift(ticket);
      this.cache = list.slice(0, this.max);
      await this.local.set(KEY, this.cache);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Writes the list as it is, after the writes already queued. */
  private save(): Promise<void> {
    const run = this.queue.then(() => this.local.set(KEY, this.cache ?? []));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.local.remove(KEY);
  }
}
