import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  bridgeAsset,
  buildChainRegistry,
  explorerTxUrl,
  findChainByAlias,
  getChain,
} from '../src/shared/chains';
import { base, bsc, elysium, ethereum, robinhood } from '../src/shared/chains/definitions';
import { bridgeGasReserve } from '../src/shared/networks';

describe('chain registry', () => {
  it('loads the launch chains, without the archived Arbitrum', () => {
    expect([...CHAINS.keys()].sort((a, b) => a - b)).toEqual([1, 56, 4663, 8453, 99901]);
    expect(getChain(42161)).toBeUndefined();
  });

  it('checksums wrapped-native addresses', () => {
    expect(getChain(8453)?.wrappedNative).toBe('0x4200000000000000000000000000000000000006');
    expect(getChain(1)?.wrappedNative).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
  });

  it('resolves URL slugs case-insensitively', () => {
    expect(findChainByAlias('BSC')?.id).toBe(56);
    expect(findChainByAlias('eth')?.id).toBe(1);
    expect(findChainByAlias('robinhood')?.id).toBe(4663);
    expect(findChainByAlias('solana')).toBeUndefined();
  });

  it('hides MEV protection on sequencer L2s', () => {
    expect(getChain(8453)?.mev.supported).toBe(false);
    expect(getChain(4663)?.mev.supported).toBe(false);
    expect(getChain(1)?.mev.supported).toBe(true);
  });

  it('builds explorer links', () => {
    const chain = getChain(56);
    expect(chain && explorerTxUrl(chain, '0xabc')).toBe('https://bscscan.com/tx/0xabc');
  });

  it('rejects duplicate ids and aliases', () => {
    expect(() => buildChainRegistry([ethereum, { ...base, id: 1 }])).toThrow(/duplicate chain id/);
    expect(() => buildChainRegistry([bsc, { ...robinhood, aliases: ['bnb'] }])).toThrow(
      /duplicate chain alias/,
    );
  });

  it('bridges out of Elysium in its USDC, and every other chain in its own coin', () => {
    expect(bridgeAsset(getChain(99901)!)).toMatchObject({ symbol: 'USDC', decimals: 6 });
    for (const id of [1, 56, 4663, 8453]) expect(bridgeAsset(getChain(id)!)).toBeUndefined();
    // Three transactions there (swap, approval, deposit): more gas kept back by MAX.
    expect(bridgeGasReserve(99901)).toBe(5n * bridgeGasReserve(8453));
    expect(bridgeGasReserve(1)).toBeGreaterThan(bridgeGasReserve(8453));
  });

  it("refuses a bridge asset that is not one of the chain's stablecoins", () => {
    expect(() => buildChainRegistry([{ ...elysium, bridgeVia: elysium.wrappedNative }])).toThrow(
      /bridge asset of elysium/,
    );
  });

  it('rejects invalid definitions', () => {
    expect(() => buildChainRegistry([{ ...base, rpcUrls: ['http://insecure.example'] }])).toThrow();
    expect(() => buildChainRegistry([{ ...base, wrappedNative: '0x1234' }])).toThrow();
    expect(() =>
      buildChainRegistry([{ ...base, quickBuyAmounts: ['0.1', 'abc', '1', '2'] }]),
    ).toThrow();
  });
});
