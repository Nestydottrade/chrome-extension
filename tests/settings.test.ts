import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import type { KeyValueStore } from '../src/background/vault/vault';
import { chainContext } from '../src/background/trade/engine';
import { getChain } from '../src/shared/chains';
import {
  PanelChainPatchSchema,
  TradePrefsSchema,
  defaultChainSettings,
  effectivePreset,
  withPrefs,
} from '../src/shared/settings/defaults';

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

describe('chain trade settings', () => {
  const base = defaultChainSettings(getChain(8453)!);

  it('defaults to 10% slippage and the medium priority level', () => {
    expect(base.slippageBps).toBe(1000);
    expect(effectivePreset(base)).toEqual({
      priorityFeeGwei: base.priorityGwei.medium,
      maxFeeMultiplier: base.maxFeeMultiplier,
      slippageBps: 1000,
    });
  });

  it('uses the custom priority fee when selected', () => {
    const cs = { ...base, priority: 'custom' as const, customPriorityGwei: '0.42' };
    expect(effectivePreset(cs).priorityFeeGwei).toBe('0.42');
  });

  it('lets the panel change trade options but never RPC URLs', () => {
    expect(
      PanelChainPatchSchema.safeParse({ slippageBps: 2000, priority: 'high', mevEnabled: true })
        .success,
    ).toBe(true);
    expect(
      PanelChainPatchSchema.safeParse({ quickBuyAmounts: ['0.1', '0.2', '0.3', '0.4'] }).success,
    ).toBe(true);
    expect(PanelChainPatchSchema.safeParse({ customRpc: 'https://evil.example' }).success).toBe(
      false,
    );
    expect(PanelChainPatchSchema.safeParse({ mevRpc: 'https://evil.example' }).success).toBe(false);
    expect(PanelChainPatchSchema.safeParse({ slippageBps: 9000 }).success).toBe(false);
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [1000, 3333, 5000, 10_000] }).success,
    ).toBe(true);
    expect(PanelChainPatchSchema.safeParse({ quickSellBps: [0, 2500, 5000, 10_000] }).success).toBe(
      false,
    );
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 5000, 7500, 10_001] }).success,
    ).toBe(false);
    expect(PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 5000] }).success).toBe(false);
  });

  it('lets a website trade carry its own trade settings, never an RPC, a limit or the gas cap', () => {
    expect(
      TradePrefsSchema.safeParse({
        chain: { slippageBps: 2000, priority: 'high', maxTaxBps: 1000, mevEnabled: false },
        solana: {
          slippageBps: 1500,
          priority: 'custom',
          customPriorityFeeSol: '0.001',
          priorityFeeSol: { low: '0.0001', medium: '0.0002', high: '0.003' },
        },
        global: { jitterMaxMs: 100, buyVarianceBps: 500 },
      }).success,
    ).toBe(true);
    expect(TradePrefsSchema.safeParse({}).success).toBe(true);
    for (const bad of [
      { chain: { customRpc: 'https://evil.example' } },
      { chain: { wsRpc: 'wss://evil.example' } },
      { chain: { mevRpc: 'https://evil.example' } },
      { chain: { maxFeeMultiplier: 9 } },
      { chain: { slippageBps: 9000 } },
      { solana: { customRpc: 'https://evil.example' } },
      { global: { maxUsdPerTx: 1e9 } },
      { global: { confirmAboveUsd: 1e9 } },
      { global: { maxGasUsd: 1e9 } },
      { global: { unlimitedApprovals: true } },
      { global: { jitterMaxMs: 5000 } },
      { limits: {} },
    ])
      expect(TradePrefsSchema.safeParse(bad).success).toBe(false);
  });

  it("runs a trade with a website's settings in place of the stored ones, and only those", async () => {
    const settings = new SettingsStore(new MemoryStore());
    const d = {
      settings,
      client: () => ({}),
      fetchJson: async () => null,
      now: () => 0,
    } as unknown as Parameters<typeof chainContext>[0];
    const stored = await settings.getChain(8453);
    const global = await settings.get();
    const { cs, gs } = await chainContext(d, 8453, {
      chain: { slippageBps: 2000, priority: 'high' },
      global: { jitterMaxMs: 100 },
    });
    expect(cs).toEqual({ ...stored, slippageBps: 2000, priority: 'high' });
    expect(gs).toEqual({ ...global, jitterMaxMs: 100 });
    // Nothing is stored: the next trade runs with the user's own again.
    expect(await settings.getChain(8453)).toEqual(stored);
    expect((await chainContext(d, 8453)).cs).toEqual(stored);
    // A field left out keeps the stored value.
    expect(withPrefs(stored, { slippageBps: undefined })).toBe(stored);
  });

  it('reads settings saved by the old P1–P3 version without breaking', async () => {
    const local = new MemoryStore();
    await local.set('nesty.chain.8453', {
      quickBuyAmounts: ['0.002', '0.004', '0.008', '0.016'],
      presets: { p1: {}, p2: {}, p3: {} },
      activePreset: 'p2',
      customRpc: '',
      mevEnabled: false,
      mevRpc: '',
    });
    const cs = await new SettingsStore(local).getChain(8453);
    expect(cs.quickBuyAmounts).toEqual(['0.002', '0.004', '0.008', '0.016']);
    expect(cs.slippageBps).toBe(1000);
    expect(cs.priority).toBe('medium');
    expect(cs).not.toHaveProperty('activePreset');
  });

  it('keeps panel positions per site, by the sender origin', async () => {
    const local = new MemoryStore();
    const store = new SettingsStore(local);
    await store.setPanelPrefs('https://gmgn.ai', { x: 10, y: 20, minimized: true, hidden: false });
    expect(await store.panelPrefs('https://gmgn.ai')).toEqual({
      x: 10,
      y: 20,
      minimized: true,
      hidden: false,
    });
    // Same key the content script used before, so saved positions survive the update.
    expect(await local.get('nesty.panel.gmgn.ai')).toBeTruthy();
    expect((await store.panelPrefs('https://dexscreener.com')).x).toBe(-1);
    expect((await store.panelPrefs(undefined)).x).toBe(-1);
    await local.set('nesty.panel.bad.example', { x: 'nope' });
    expect((await store.panelPrefs('https://bad.example')).x).toBe(-1);
  });

  it('fills an empty private RPC with the chain default (BSC included), protection stays a choice', async () => {
    const local = new MemoryStore();
    // Saved before BSC had a default: MEV "on" with no RPC used to mean the public mempool.
    await local.set('nesty.chain.56', { mevEnabled: true, mevRpc: '' });
    await local.set('nesty.chain.1', { mevEnabled: false, mevRpc: '' });
    const store = new SettingsStore(local);
    const bsc = await store.getChain(56);
    expect(bsc.mevEnabled).toBe(true);
    expect(bsc.mevRpc).toBe('https://bscrpc.pancakeswap.finance');
    const eth = await store.getChain(1);
    expect(eth.mevEnabled).toBe(false);
    expect(eth.mevRpc).toBe('https://rpc.flashbots.net/fast');
    // Chains without a mempool keep no private RPC.
    expect((await store.getChain(8453)).mevRpc).toBe('');
  });
});

describe('settings repair and limits', () => {
  it('resets only the invalid field of saved settings, and says which', async () => {
    const local = new MemoryStore();
    await local.set('nesty.settings', { maxUsdPerTx: 40, maxUsdPerClick: 80, jitterMaxMs: 9999 });
    await local.set('nesty.chain.56', {
      slippageBps: 0,
      quickBuyAmounts: ['0.1', '0.2', '0.3', '0.4'],
    });
    const store = new SettingsStore(local);
    const g = await store.get();
    expect(g.maxUsdPerTx).toBe(40);
    expect(g.maxUsdPerClick).toBe(80);
    expect(g.jitterMaxMs).toBe(0);
    const bsc = await store.getChain(56);
    expect(bsc.quickBuyAmounts).toEqual(['0.1', '0.2', '0.3', '0.4']);
    expect(bsc.slippageBps).toBe(1000);
    expect(store.repairs()).toEqual(['jitterMaxMs', 'BSC: slippageBps']);
  });

  it('refuses limits that contradict each other, with the reason', async () => {
    const store = new SettingsStore(new MemoryStore());
    await expect(store.update({ maxUsdPerTx: 100 })).rejects.toThrow(
      /can't be above max per click/,
    );
    await expect(store.update({ priceImpactWarnBps: 900 })).rejects.toThrow(
      /warning can't be above/,
    );
    await store.update({ maxUsdPerClick: 200 });
    expect((await store.update({ maxUsdPerTx: 100 })).maxUsdPerTx).toBe(100);
  });

  it('refuses quick buttons with the same value, from the panel and the popup', async () => {
    const store = new SettingsStore(new MemoryStore());
    await expect(
      store.updateChain(8453, { quickBuyAmounts: ['0.01', '0.010', '0.05', '0.1'] }),
    ).rejects.toThrow(/must all be different/);
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 2500, 7500, 10_000] }).success,
    ).toBe(false);
  });

  it('starts with hotkeys off', async () => {
    expect((await new SettingsStore(new MemoryStore()).get()).hotkeysEnabled).toBe(false);
  });
});
