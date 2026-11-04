import { describe, expect, it } from 'vitest';
import { SolRpc, SolRpcError, keysLimit } from '../src/background/solana/rpc';

const SYSTEM = '11111111111111111111111111111111';

/** A node that takes at most `max` keys per read, refusing more the way publicnode does. */
function node(max: number) {
  const sizes: number[] = [];
  const fetchFn = async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number; params: [string[]] };
    const keys = req.params[0];
    sizes.push(keys.length);
    if (keys.length > max)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32602,
            message: `A maximum of ${max} accounts is allowed. No limit on paid plans.`,
          },
        }),
        { status: 403 },
      );
    const value = keys.map((k) => ({
      owner: SYSTEM,
      lamports: Number(k.slice(1)),
      data: ['', 'base64'],
      executable: false,
    }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { value } }));
  };
  return { fetchFn, sizes };
}

const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

describe('SolRpc.getMultipleAccounts', () => {
  it('reads in smaller pieces once an endpoint says how many keys it takes, and remembers', async () => {
    const { fetchFn, sizes } = node(10);
    const rpc = new SolRpc(['https://rpc.example'], fetchFn);
    const got = await rpc.getMultipleAccounts(keys(25));
    expect(got.map((a) => a?.lamports)).toEqual(keys(25).map((_, i) => BigInt(i)));
    expect(sizes).toEqual([25, 10, 10, 5]);
    sizes.length = 0;
    await rpc.getMultipleAccounts(keys(12));
    expect(sizes).toEqual([10, 2]);
  });

  it('still treats any other HTTP error as the endpoint failing', async () => {
    const rpc = new SolRpc(
      ['https://rpc.example'],
      async () => new Response('Forbidden', { status: 403 }),
    );
    await expect(rpc.getMultipleAccounts(keys(3))).rejects.toEqual(
      new SolRpcError(-32005, 'HTTP 403'),
    );
  });

  it('reads the limit from the refusal only', () => {
    expect(keysLimit('A maximum of 10 accounts is allowed. No limit on paid plans.')).toBe(10);
    expect(keysLimit('Too many requests')).toBeNull();
    expect(keysLimit('A maximum of 0 accounts is allowed')).toBeNull();
  });
});
