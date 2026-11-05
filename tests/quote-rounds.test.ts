import { parseAbi, type Address, type ContractFunctionParameters, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { sharedMulticall } from '../src/background/chain/client';
import { Routing } from '../src/background/trade/routing';
import type { PoolRef, Venue, VenueCtx } from '../src/background/trade/types';
import { getChain } from '../src/shared/chains';

const TOKEN: Address = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

describe('shared multicalls', () => {
  const abi = parseAbi(['function f(uint256) view returns (uint256)']);
  const call = (n: bigint): ContractFunctionParameters => ({
    address: TOKEN,
    abi,
    functionName: 'f',
    args: [n],
  });

  /** A client whose multicall answers each call with its argument, and counts requests. */
  function client(fail = false) {
    const requests: number[] = [];
    const c = {
      multicall: async ({ contracts }: { contracts: readonly ContractFunctionParameters[] }) => {
        requests.push(contracts.length);
        if (fail) throw new Error('429');
        return contracts.map((x) => ({ status: 'success', result: x.args?.[0] }));
      },
    } as unknown as PublicClient;
    return { c, requests };
  }

  it('sends the calls of one tick together and hands each caller its own results', async () => {
    const { c, requests } = client();
    const [a, b, empty] = await Promise.all([
      sharedMulticall(c, [call(1n), call(2n)]),
      sharedMulticall(c, [call(3n)]),
      sharedMulticall(c, []),
    ]);
    expect(requests).toEqual([3]);
    expect(a.map((r) => (r.status === 'success' ? r.result : null))).toEqual([1n, 2n]);
    expect(b.map((r) => (r.status === 'success' ? r.result : null))).toEqual([3n]);
    expect(empty).toEqual([]);
  });

  it('sends calls made after an answer in a new request', async () => {
    const { c, requests } = client();
    await sharedMulticall(c, [call(1n)]);
    await sharedMulticall(c, [call(2n)]);
    expect(requests).toEqual([1, 1]);
  });

  it('rejects every caller when the request fails', async () => {
    const { c } = client(true);
    const both = await Promise.allSettled([
      sharedMulticall(c, [call(1n)]),
      sharedMulticall(c, [call(2n)]),
    ]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});

describe('refresh rounds quote only the pools that won', () => {
  let now = 1_000_000;
  const ctx: VenueCtx = { chain: getChain(56)!, client: {} as never, now: () => now };

  /** Pools quoting `rate` tokens per unit in (null: no quote), and every pool quoted. */
  function setup(rates: Record<string, bigint | null>) {
    const quoted: string[] = [];
    const venue: Venue = {
      id: 'dex',
      supports: () => true,
      discover: async (_c, token) =>
        Object.keys(rates).map(
          (id) => ({ venueId: 'dex', id, label: id, token, data: null }) satisfies PoolRef,
        ),
      quote: async (_c, pool, _s, amounts) => {
        quoted.push(pool.id);
        const rate = rates[pool.id] ?? null;
        return amounts.map((a) => (rate === null ? null : a * rate));
      },
      buildBuy: () => ({ to: TOKEN, data: '0x', value: 0n }),
      buildSell: () => ({ to: TOKEN, data: '0x', value: 0n }),
      sellApproval: () => ({ spender: TOKEN, viaPermit2: false, router: TOKEN }),
    };
    const routing = new Routing([venue]);
    /** The pools a call quoted, in order of asking. */
    const asked = async (run: () => Promise<unknown>): Promise<string[]> => {
      const from = quoted.length;
      await run();
      return quoted.slice(from);
    };
    const refresh = (amounts: bigint[] = [10n, 20n]) =>
      routing.bestWithRef(ctx, TOKEN, 'buy', 1n, amounts, { refresh: true });
    const winners = async (amounts?: bigint[]) =>
      (await refresh(amounts)).map((r) => r.route?.pool.id ?? null);
    return { routing, refresh, winners, asked };
  }

  it('asks every pool first, then only the winner until a full round is due', async () => {
    const { refresh, winners, asked } = setup({ a: 1000n, b: 1010n, c: 990n });
    expect(await asked(refresh)).toEqual(['a', 'b', 'c']);
    now += 5_000;
    expect(await asked(refresh)).toEqual(['b']);
    now += 5_000;
    expect(await winners()).toEqual(['b', 'b']);
    now += 6_000; // 16 s after the full round
    expect(await asked(refresh)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the price impact reference on the winning pool', async () => {
    const { refresh } = setup({ a: 1000n, b: 1010n });
    await refresh();
    now += 1_000;
    const [first] = await refresh();
    expect(first?.route?.pool.id).toBe('b');
    expect(first?.refOut).toBe(1010n);
  });

  it('asks every pool again at once when a winner stops quoting', async () => {
    const rates: Record<string, bigint | null> = { a: 1000n, b: 1010n, c: 990n };
    const { refresh, winners, asked } = setup(rates);
    await refresh();
    rates.b = null;
    now += 1_000;
    // The winner alone, then every pool in the same call.
    expect(await asked(refresh)).toEqual(['b', 'a', 'b', 'c']);
    now += 1_000;
    expect(await winners()).toEqual(['a', 'a']);
  });

  it('asks every pool again when no winner is listed any more', async () => {
    const rates: Record<string, bigint | null> = { a: 1000n, b: 1010n };
    const { routing, refresh, asked } = setup(rates);
    await refresh();
    delete rates.b;
    await routing.discover(ctx, TOKEN, true);
    now += 1_000;
    expect(await asked(refresh)).toEqual(['a']);
  });

  it('starts over for other amounts', async () => {
    const { refresh, asked } = setup({ a: 1000n, b: 1010n });
    await refresh();
    now += 1_000;
    expect(await asked(() => refresh([10n, 20n, 30n]))).toEqual(['a', 'b']);
  });

  it('never narrows a lookup that is not a refresh (a click)', async () => {
    const { routing, refresh, asked } = setup({ a: 1000n, b: 1010n });
    await refresh();
    now += 1_000;
    expect(await asked(() => routing.best(ctx, TOKEN, 'buy', [10n]))).toEqual(['a', 'b']);
    expect(await asked(() => routing.bestWithRef(ctx, TOKEN, 'buy', 1n, [10n, 20n]))).toEqual([
      'a',
      'b',
    ]);
  });
});
