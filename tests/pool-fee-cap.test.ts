import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { VenueCtx } from '../src/background/trade/types';
import type { PoolKey } from '../src/background/trade/uniswap/codec';
import { poolIdOf, uniswapVenue, type UniPool } from '../src/background/trade/uniswap/venue';
import { getChain } from '../src/shared/chains';

// Elysium Inu: a Montra coin paired with KNTQ, whose only native pool the index listed was
// a hook-less v4 pool charging 84.369%, with a few dollars in it.
const COIN: Address = getAddress('0xd341d1e765afba20f591162ab976892dddf5cdee');
const HOOK: Address = '0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC';

const native = (fee: number, hooks: Address = zeroAddress): PoolKey => ({
  currency0: zeroAddress,
  currency1: COIN,
  fee,
  tickSpacing: 200,
  hooks,
});
const trap = native(843_690);
const justAbove = native(100_001);
const atCap = native(100_000);
const dynamic = native(0x800000, HOOK);

interface Call {
  functionName: string;
  args?: readonly unknown[];
}

/** The pool index lists `listed`, each of them holds liquidity; there are no v2 or v3 pools. */
function elysiumCtx(listed: PoolKey[]) {
  const ids = new Set(listed.map(poolIdOf));
  const byPrefix = new Map(listed.map((k) => [poolIdOf(k).slice(0, 52), k]));
  const liquidityRead: Hex[] = [];
  const client = {
    readContract: async ({ functionName, args }: Call) => {
      if (functionName !== 'poolKeys') throw new Error(`no ${functionName}`);
      const k = byPrefix.get(String(args?.[0]).toLowerCase());
      if (!k) throw new Error('unknown pool');
      return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks] as const;
    },
    multicall: async ({ contracts }: { contracts: Call[] }) =>
      contracts.map((c) => {
        if (c.functionName !== 'getLiquidity') return { status: 'success', result: zeroAddress };
        const id = c.args?.[0] as Hex;
        liquidityRead.push(id);
        return { status: 'success', result: ids.has(id) ? 10n ** 18n : 0n };
      }),
  };
  const ctx = {
    chain: getChain(99901)!,
    client,
    fetchJson: async () => ({
      pairs: listed.map((k) => ({ chainId: 'elysium', pairAddress: poolIdOf(k) })),
    }),
    now: () => 0,
  } as unknown as VenueCtx;
  return { ctx, liquidityRead };
}

describe('Uniswap pools with a fixed fee above 10%', () => {
  it('are never traded through, nor even read', async () => {
    const { ctx, liquidityRead } = elysiumCtx([trap, justAbove, atCap, dynamic]);
    const pools = await uniswapVenue.discover(ctx, COIN);
    const found = pools.map((p) => p.id);
    expect(found).not.toContain(poolIdOf(trap));
    expect(found).not.toContain(poolIdOf(justAbove));
    expect(liquidityRead).not.toContain(poolIdOf(trap));
    // 10% itself stays, and so does a hook's dynamic fee: the quote shows what it takes.
    expect(found).toContain(poolIdOf(atCap));
    expect(found).toContain(poolIdOf(dynamic));
    for (const p of pools) {
      const d = p.data as UniPool;
      if (d.kind === 'v4' && !(d.key.fee & 0x800000))
        expect(d.key.fee).toBeLessThanOrEqual(100_000);
    }
  });

  it('leave a coin whose only native pool is such a trap with no route', async () => {
    const { ctx } = elysiumCtx([trap]);
    expect(await uniswapVenue.discover(ctx, COIN)).toEqual([]);
  });
});
