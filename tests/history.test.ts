import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/background/history';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { TicketLeg, TradeTicket } from '../src/shared/panel';

class Store implements KeyValueStore {
  data = new Map<string, unknown>();
  writes = 0;
  async get(k: string) {
    return this.data.get(k);
  }
  async set(k: string, v: unknown) {
    this.writes++;
    this.data.set(k, structuredClone(v));
  }
  async remove(k: string) {
    this.data.delete(k);
  }
}

const ticket = (id: string, status: TradeTicket['status'], legs: Partial<TicketLeg>[]) =>
  ({
    id,
    kind: 'buy',
    chainId: 8453,
    status,
    legs,
    createdAt: 0,
    explorer: '',
  }) as unknown as TradeTicket;

const saved = (store: Store) => (store.data.get('nesty.history') as TradeTicket[]).map((t) => t.id);

/** Lets the writes already queued finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('history', () => {
  it('keeps no trade that the checks stopped before sending', async () => {
    const store = new Store();
    const history = new HistoryStore(store);
    await history.upsert(ticket('a', 'working', [{ status: 'queued' }]));
    await history.upsert(
      ticket('a', 'failed', [{ status: 'failed', error: 'Insufficient balance: needs 0.001 ETH' }]),
    );
    await history.upsert(ticket('b', 'blocked', [{ status: 'blocked' }]));
    expect(await history.list()).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it('keeps a trade from its first sent transaction on, in its latest state', async () => {
    const store = new Store();
    const history = new HistoryStore(store);
    await history.upsert(ticket('a', 'working', [{ status: 'queued' }]));
    await history.upsert(ticket('a', 'working', [{ status: 'submitted', hash: '0xaa' }]));
    await history.upsert(ticket('a', 'done', [{ status: 'confirmed', hash: '0xaa' }]));
    expect((await history.list()).map((t) => [t.id, t.status])).toEqual([['a', 'done']]);
    expect(saved(store)).toEqual(['a']);
  });

  it('keeps trades that failed on chain, and Solana trades by their signature', async () => {
    const history = new HistoryStore(new Store());
    await history.upsert(
      ticket('evm', 'failed', [{ status: 'failed', hash: '0xbb', error: 'Reverted' }]),
    );
    await history.upsert(
      ticket('sol', 'failed', [{ status: 'failed', sig: '5abc', error: 'Slippage' }]),
    );
    expect((await history.list()).map((t) => t.id)).toEqual(['sol', 'evm']);
  });

  it('drops saved tickets that never reached the chain, from storage too', async () => {
    const store = new Store();
    store.data.set('nesty.history', [
      ticket('a', 'done', [{ status: 'confirmed', hash: '0xaa' }]),
      ticket('b', 'failed', [
        { status: 'failed', error: 'Insufficient SOL: about 0.0565 needed.' },
      ]),
      ticket('c', 'partial', [
        { status: 'confirmed', sig: '5abc' },
        { status: 'failed', error: 'x' },
      ]),
    ]);
    const history = new HistoryStore(store);
    expect((await history.list()).map((t) => t.id)).toEqual(['a', 'c']);
    await settle();
    expect(saved(store)).toEqual(['a', 'c']);
  });

  it('writes nothing on reading when every saved ticket reached the chain', async () => {
    const store = new Store();
    store.data.set('nesty.history', [ticket('a', 'done', [{ status: 'confirmed', hash: '0xaa' }])]);
    await new HistoryStore(store).list();
    await settle();
    expect(store.writes).toBe(0);
  });
});
