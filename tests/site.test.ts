import { ed25519 } from '@noble/curves/ed25519';
import { base58, base64 } from '@scure/base';
import {
  encodeFunctionData,
  parseGwei,
  parseSignature,
  recoverTransactionAddress,
  serializeTransaction,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { erc20Abi } from '../src/background/chain/abis';
import { AlertWatcher } from '../src/background/alerts';
import { TrackerWatcher } from '../src/background/tracker';
import { SettingsStore } from '../src/background/settings';
import { SiteError, SiteService, type SiteDeps } from '../src/background/site';
import { COMPUTE_BUDGET_PROGRAM } from '../src/background/solana/address';
import { publicKeyOf } from '../src/background/solana/keys';
import type { SiteTradeCheck } from '../src/background/solana/service';
import { compileMessage } from '../src/background/solana/tx';
import { TradeError } from '../src/background/trade/engine';
import { txToWire, type EvmTx } from '../src/background/trade/signer';
import type { SiteEvmCheck } from '../src/background/trade/site-evm';
import { VaultError, type KeyValueStore } from '../src/background/vault/vault';
import type { BridgeQuoteView, RequestOf } from '../src/shared/messages';
import type { QuoteSet, TradeTicket } from '../src/shared/panel';
import type { SiteBridgeRequest, SitePendingView } from '../src/shared/site-bridge';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

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

// A throwaway key made up for the test: never a real wallet's.
const SEED = new Uint8Array(32).fill(7);
const WALLET = publicKeyOf(SEED);
const SITE = 'http://localhost:5173';
const OTHER = 'http://127.0.0.1:5173';
const HOSTED = 'https://nesty.trade';
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(1));
const LIMIT = Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]);
const EVM_KEY = `0x${'22'.repeat(32)}` as const;
const EVM = privateKeyToAccount(EVM_KEY).address;
const TOKEN = '0x00000000000000000000000000000000000070c0';
// Made up for the tests, like the keys above.
const PASSWORD = 'Correct horse battery 9!';
const STRANGER = publicKeyOf(new Uint8Array(32).fill(9));

function setup(
  check: SiteTradeCheck = { ok: true, summary: 'Buy', usd: 5 },
  evmCheck: SiteEvmCheck = { ok: true, summary: 'Buy', usd: 5 },
  /** Sites in from the start, and the storage (shared, it outlasts a restart). */
  start: { connectedByDefault?: readonly string[]; local?: MemoryStore } = {},
) {
  const state = {
    unlocked: true,
    answer: true as boolean | null,
    now: 1_000_000,
    opened: 0,
    /** What the approval window sends with its answer. */
    password: undefined as string | undefined,
    /** A bridge's value in USD, as its quote says. */
    bridgeUsd: 5 as number | null,
    views: [] as (SitePendingView | null)[],
    /** A buy's value in USD, as the engine works it out before it asks its gate. */
    buyUsd: 5,
  };
  const checkSiteTrade = vi.fn(async () => check);
  const checkSiteCreate = vi.fn(async () => check);
  const evm = {
    checkTx: vi.fn(async () => evmCheck),
    checkPermit: vi.fn(async () => evmCheck),
    noteSigned: vi.fn(),
  };
  const bridge = {
    quote: vi.fn(async (): Promise<BridgeQuoteView> => ({
      amountOut: '3210000000',
      minOut: '3190000000',
      slippageBps: 50,
      feeUsd: 0.4,
      timeEstimateS: 20,
      amountInUsd: state.bridgeUsd,
    })),
    send: vi.fn(async (req: SiteBridgeRequest) => bridgeTicket(`t-${req.amount}`)),
  };
  // The extension's engines: each trade they are asked for passes its gate, then is made.
  let made = 0;
  type Asked = {
    gate?: (b: { usd: number; spend: string; coin: string | null }) => Promise<boolean>;
  };
  const trade = (kind: 'buy' | 'sell', chainId: number) => async (req: Asked) => {
    if (req.gate) await req.gate({ usd: state.buyUsd, spend: '0.01 ETH', coin: 'COIN' });
    return tradeTicket(`${kind}-${++made}`, chainId);
  };
  const engine = {
    buy: vi.fn(trade('buy', 8453)),
    sell: vi.fn(trade('sell', 8453)),
    replace: vi.fn(async (id: string) => tradeTicket(id, 8453)),
  };
  const sol = {
    buy: vi.fn(trade('buy', SOLANA_CHAIN_ID)),
    sell: vi.fn(trade('sell', SOLANA_CHAIN_ID)),
    panelQuotes: vi.fn(async () => QUOTES),
    notePagePool: vi.fn(),
  };
  const quotes = vi.fn(async () => QUOTES);
  /** Tab, ticket and its status, as each push went out. */
  const pushed: [number, string, string][] = [];
  let n = 0;
  const deps: SiteDeps = {
    vault: {
      exists: async () => true,
      isUnlocked: async () => state.unlocked,
      listAccounts: async () => [
        { id: 'w1', name: 'Main', hidden: false, primary: true, kind: 'derived', solana: WALLET },
        { id: 'w2', name: 'Base', hidden: false, primary: false, kind: 'derived', address: EVM },
      ],
      solanaKeyFor: async () => SEED.slice(),
      privateKeyFor: async () => EVM_KEY,
      verifyPassword: async (password: string) => {
        if (password !== PASSWORD) throw new VaultError('bad_password');
      },
    },
    bridge,
    solana: { ...sol, checkSiteTrade, checkSiteCreate } as unknown as SiteDeps['solana'],
    engine: engine as unknown as SiteDeps['engine'],
    quotes,
    pushTicket: (tabId, ticket) => void pushed.push([tabId, ticket.id, ticket.status]),
    evm,
    // No price is ever found: alerts here are only kept, never fired.
    alerts: new AlertWatcher({
      local: new MemoryStore(),
      fetchJson: async () => [],
      notify: async () => undefined,
      blocked: async () => false,
      schedule: async () => undefined,
      newId: () => `alert-${++n}`,
      now: () => state.now,
    }),
    // Nothing is ever read: wallets here are only kept.
    tracker: new TrackerWatcher({
      local: new MemoryStore(),
      fetchJson: async () => [],
      notify: async () => undefined,
      blocked: async () => false,
      schedule: async () => undefined,
      sol: async () => ({ signatures: async () => [], transaction: async () => null }),
      evm: async () => null,
      evmChains: () => [],
      newId: () => `wallet-${++n}`,
      now: () => state.now,
    }),
    settings: new SettingsStore(new MemoryStore()),
    local: start.local ?? new MemoryStore(),
    connectedByDefault: start.connectedByDefault ?? [],
    openApproval: async (id) => {
      state.opened++;
      state.views.push(site.pendingView(id));
      const answer = state.answer;
      // null: the user does nothing until the test closes the window.
      if (answer !== null) queueMicrotask(() => void site.decide(id, answer, state.password));
      return 41;
    },
    openUnlock: async () => 42,
    newId: () => `req-${++n}`,
    version: '0.1.4',
    now: () => state.now,
  };
  const site = new SiteService(deps);
  return { site, state, checkSiteTrade, checkSiteCreate, evm, bridge, engine, sol, quotes, pushed };
}

const QUOTES: QuoteSet = {
  buys: [],
  sells: [],
  tokenUsd: null,
  venue: null,
  idle: null,
  tax: null,
  taxUnknown: false,
  fetchedAt: 0,
};

const tradeTicket = (id: string, chainId: number): TradeTicket => ({
  id,
  kind: 'buy',
  chainId,
  status: 'working',
  legs: [{ walletId: 'w2', walletName: 'Base', kind: 'swap', status: 'queued' }],
  createdAt: 0,
  explorer: 'https://basescan.org',
});

const bridgeTicket = (id: string): TradeTicket => ({
  id,
  kind: 'bridge',
  chainId: 8453,
  status: 'working',
  legs: [
    {
      walletId: 'w2',
      walletName: 'Base',
      kind: 'bridge',
      status: 'submitted',
      hash: `0x${'ab'.repeat(32)}`,
    },
  ],
  createdAt: 0,
  explorer: 'https://basescan.org',
  bridge: {
    toChainId: SOLANA_CHAIN_ID,
    amountIn: '10000000000000000',
    amountOut: '3210000000',
    recipientName: 'Main',
    requestId: '0x01',
    relayStatus: 'pending',
  },
});

/** Base to Solana, into the user's own wallet. */
const BRIDGE: SiteBridgeRequest = {
  fromChainId: 8453,
  toChainId: SOLANA_CHAIN_ID,
  amount: '0.01',
  fromWalletId: 'w2',
  toWalletId: 'w1',
};

const sign = (side: 'buy' | 'sell' = 'buy'): RequestOf<'site.sol.sign'> => ({
  type: 'site.sol.sign',
  walletId: 'w1',
  blockhash: BLOCKHASH,
  instructions: [{ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: base64.encode(LIMIT) }],
  intent: { kind: 'trade', mint: WALLET, side, route: { kind: 'pump' } },
});

describe('the Nesty website', () => {
  it('is let in once the user approves it, and only that origin', async () => {
    const { site, state } = setup();
    expect((await site.hello(SITE)).connected).toBe(false);
    const wallets = await site.connect(SITE);
    expect(wallets).toEqual([
      { id: 'w1', name: 'Main', evm: null, solana: WALLET, primary: true, hidden: false },
      { id: 'w2', name: 'Base', evm: EVM, solana: null, primary: false, hidden: false },
    ]);
    expect(state.opened).toBe(1);
    await site.connect(SITE);
    expect(state.opened).toBe(1);
    expect((await site.hello(SITE)).connected).toBe(true);
    await expect(site.wallets(OTHER)).rejects.toEqual(new SiteError('not_connected'));
    await site.disconnect(SITE);
    await expect(site.wallets(SITE)).rejects.toEqual(new SiteError('not_connected'));
  });

  it('keeps price alerts for a connected site only, and keeps them while it is turned off', async () => {
    const { site, state } = setup();
    const alert: RequestOf<'site.alerts.set'> = {
      type: 'site.alerts.set',
      chainId: SOLANA_CHAIN_ID,
      token: WALLET,
      symbol: 'COIN',
      above: true,
      price: 0.002,
    };
    await expect(site.setAlert(SITE, alert)).rejects.toEqual(new SiteError('not_connected'));
    await expect(site.alerts(SITE)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    // No key is involved: a locked wallet keeps them too.
    state.unlocked = false;
    const set = await site.setAlert(SITE, alert);
    expect(set).toMatchObject({
      token: WALLET,
      symbol: 'COIN',
      above: true,
      price: 0.002,
      supply: null,
    });
    const listed = await site.alerts(SITE);
    expect(listed.alerts.map((x) => x.id)).toEqual([set.id]);
    expect(listed.blocked).toBe(false);
    await expect(site.alerts(OTHER)).rejects.toEqual(new SiteError('not_connected'));
    await site.removeAlert(SITE, set.id);
    expect((await site.alerts(SITE)).alerts).toEqual([]);

    const kept = await site.setAlert(SITE, alert);
    await site.disconnect(SITE);
    await expect(site.alerts(SITE)).rejects.toEqual(new SiteError('not_connected'));
    state.unlocked = true;
    await site.connect(SITE);
    expect((await site.alerts(SITE)).alerts.map((x) => x.id)).toEqual([kept.id]);
  });

  it('keeps the wallets a site follows while it is turned off', async () => {
    const { site } = setup();
    await site.connect(SITE);
    await site.follow(SITE, { type: 'site.tracker.follow', address: EVM, name: 'Whale' });
    await site.disconnect(SITE);
    await expect(site.trackerFeed(SITE)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    expect((await site.trackerFeed(SITE)).wallets.map((w) => w.name)).toEqual(['Whale']);
  });

  it('stays out when the user declines, or closes the window', async () => {
    const { site, state } = setup();
    state.answer = false;
    await expect(site.connect(SITE)).rejects.toEqual(new SiteError('rejected'));
    state.answer = null;
    const asking = site.connect(SITE);
    await vi.waitFor(() => expect(state.opened).toBe(2));
    site.windowClosed(41);
    await expect(asking).rejects.toEqual(new SiteError('rejected'));
    expect((await site.hello(SITE)).connected).toBe(false);
  });

  it('has the hosted site in from the start, until the user disconnects it', async () => {
    const start = { connectedByDefault: [HOSTED], local: new MemoryStore() };
    const { site, state } = setup(undefined, undefined, start);
    expect((await site.hello(HOSTED)).connected).toBe(true);
    expect(await site.wallets(HOSTED)).toHaveLength(2);
    await site.connect(HOSTED);
    expect(state.opened).toBe(0);
    expect(await site.connections()).toEqual([{ origin: HOSTED, at: 0 }]);
    // The development server still waits for the user's approval.
    expect((await site.hello(SITE)).connected).toBe(false);

    await site.disconnect(HOSTED);
    expect((await site.hello(HOSTED)).connected).toBe(false);
    await expect(site.wallets(HOSTED)).rejects.toEqual(new SiteError('not_connected'));
    expect(await site.connections()).toEqual([]);

    // It stays out after a restart, and gets back in only by the user's approval.
    const again = setup(undefined, undefined, start);
    expect((await again.site.hello(HOSTED)).connected).toBe(false);
    again.state.answer = false;
    await expect(again.site.connect(HOSTED)).rejects.toEqual(new SiteError('rejected'));
    again.state.answer = true;
    await again.site.connect(HOSTED);
    expect(again.state.opened).toBe(2);
    expect(await again.site.connections()).toEqual([{ origin: HOSTED, at: again.state.now }]);
    await again.site.disconnect(HOSTED);
    expect((await again.site.hello(HOSTED)).connected).toBe(false);
  });

  it('cannot connect or sign while the vault is locked', async () => {
    const { site, state } = setup();
    await site.connect(SITE);
    state.unlocked = false;
    await expect(site.connect(OTHER)).rejects.toEqual(new VaultError('locked'));
    await expect(site.signSolana(SITE, sign())).rejects.toEqual(new VaultError('locked'));
  });

  it('gets a signature on the exact message, once the trade passed its check', async () => {
    const { site, checkSiteTrade } = setup();
    await expect(site.signSolana(SITE, sign())).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    const { signature } = await site.signSolana(SITE, sign());
    const ix = { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: LIMIT };
    expect(checkSiteTrade).toHaveBeenCalledWith(WALLET, [ix], sign().intent);
    const message = compileMessage(WALLET, [ix], BLOCKHASH).bytes;
    expect(ed25519.verify(base58.decode(signature), message, base58.decode(WALLET))).toBe(true);
  });

  it('gets nothing signed that its check refuses', async () => {
    const { site } = setup({ ok: false, reason: 'Program is not on the allowlist' });
    await site.connect(SITE);
    await expect(site.signSolana(SITE, sign())).rejects.toEqual(
      new TradeError('blocked', 'Program is not on the allowlist'),
    );
  });

  it('passes the decoded actions of a refused check on', async () => {
    const actions = [{ label: 'Transfer', ok: false, reason: 'Pays an address that is not yours' }];
    const { site } = setup({ ok: false, reason: 'Pays an address that is not yours', actions });
    await site.connect(SITE);
    await expect(site.signSolana(SITE, sign())).rejects.toMatchObject({
      code: 'blocked',
      detail: 'Pays an address that is not yours',
      actions,
    });
  });

  it('waits for the user on a buy above the confirmation amount', async () => {
    const { site, state } = setup({ ok: true, summary: 'Buy', usd: 30 });
    await site.connect(SITE);
    state.answer = false;
    await expect(site.signSolana(SITE, sign())).rejects.toEqual(new SiteError('rejected'));
    state.answer = true;
    await expect(site.signSolana(SITE, sign())).resolves.toHaveProperty('signature');
    expect(state.opened).toBe(3);
  });

  it('asks once buys from the site pass the minute budget, not for sells', async () => {
    const { site, state } = setup({ ok: true, summary: 'Buy', usd: 15 });
    await site.connect(SITE);
    // $15 each, $50 a minute (the defaults): the fourth would make $60.
    for (let i = 0; i < 3; i++) await site.signSolana(SITE, sign());
    expect(state.opened).toBe(1);
    state.answer = false;
    await expect(site.signSolana(SITE, sign())).rejects.toEqual(new SiteError('rejected'));
    await site.signSolana(SITE, sign('sell'));
    expect(state.opened).toBe(2);
    // A minute later the budget is back.
    state.now += 61_000;
    await site.signSolana(SITE, sign());
    expect(state.opened).toBe(2);
  });

  it('signs an EVM transaction once its check passed, with the wallet key', async () => {
    const { site, evm } = setup();
    const tx: EvmTx = {
      chainId: 8453,
      nonce: 7,
      to: TOKEN,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TOKEN, 1n] }),
      value: 0n,
      gas: 60_000n,
      maxFeePerGas: parseGwei('2'),
      maxPriorityFeePerGas: parseGwei('0.1'),
    };
    const req = {
      type: 'site.evm.sign' as const,
      walletId: 'w2',
      tx: txToWire(tx) as RequestOf<'site.evm.sign'>['tx'],
      purpose: { kind: 'empty' as const },
    };
    await expect(site.signEvm(SITE, req)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    // A wallet without an EVM address has nothing to sign with.
    await expect(site.signEvm(SITE, { ...req, walletId: 'w1' })).rejects.toEqual(
      new VaultError('no_evm'),
    );
    const { signature } = await site.signEvm(SITE, req);
    expect(evm.checkTx).toHaveBeenCalledWith(expect.objectContaining({ id: 'w2' }), [EVM], tx, {
      kind: 'empty',
    });
    expect(evm.noteSigned).toHaveBeenCalledTimes(1);
    const signed = serializeTransaction(
      { type: 'eip1559', ...tx },
      parseSignature(signature as `0x${string}`),
    );
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(EVM);
  });

  it('signs no EVM transaction its check refuses, and asks for large EVM buys', async () => {
    const refused = setup(undefined, { ok: false, reason: 'Its minimum received is too low' });
    await refused.site.connect(SITE);
    const req = {
      type: 'site.evm.sign' as const,
      walletId: 'w2',
      tx: {
        chainId: 8453,
        nonce: 1,
        to: EVM,
        data: '0x',
        value: '0',
        gas: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '100000000',
      },
      purpose: { kind: 'empty' as const },
    };
    await expect(refused.site.signEvm(SITE, req)).rejects.toEqual(
      new TradeError('blocked', 'Its minimum received is too low'),
    );
    expect(refused.evm.noteSigned).not.toHaveBeenCalled();

    const { site, state } = setup(undefined, { ok: true, summary: 'Buy TEST', usd: 30 });
    await site.connect(SITE);
    state.answer = false;
    await expect(site.signEvm(SITE, req)).rejects.toEqual(new SiteError('rejected'));
    state.answer = true;
    await expect(site.signEvm(SITE, req)).resolves.toHaveProperty('signature');
    expect(state.opened).toBe(3);
  });

  it('always asks before creating a coin, however small its dev buy', async () => {
    const { site, state, checkSiteCreate, checkSiteTrade } = setup({
      ok: true,
      summary: 'Create CTEST on pump.fun',
      usd: 0,
    });
    await site.connect(SITE);
    const create: RequestOf<'site.sol.sign'> = {
      ...sign(),
      intent: {
        kind: 'create',
        launchpad: 'pump',
        mint: WALLET,
        name: 'Nesty Test',
        symbol: 'CTEST',
        uri: 'ipfs://bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva',
        devBuy: '0',
        minOut: '0',
      },
    };
    state.answer = false;
    await expect(site.signSolana(SITE, create)).rejects.toEqual(new SiteError('rejected'));
    state.answer = true;
    await expect(site.signSolana(SITE, create)).resolves.toHaveProperty('signature');
    expect(checkSiteCreate).toHaveBeenCalledTimes(2);
    expect(checkSiteTrade).not.toHaveBeenCalled();
    expect(state.opened).toBe(3);
    expect(site.pendingView('req-1')).toBeNull();
  });

  it('always asks before creating an EVM coin, and signs nothing its check refuses', async () => {
    const req: RequestOf<'site.evm.sign'> = {
      type: 'site.evm.sign' as const,
      walletId: 'w2',
      tx: {
        chainId: 8453,
        nonce: 1,
        to: TOKEN,
        data: '0x',
        value: '0',
        gas: '5000000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '100000000',
      },
      purpose: {
        kind: 'create' as const,
        spec: {
          launchpad: 'klik' as const,
          name: 'Nesty Test',
          symbol: 'CTEST',
          metadata: 'ipfs://bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva',
          salt: `0x${'00'.repeat(32)}`,
          devBuy: '0',
        },
      },
    };
    const refused = setup(undefined, { ok: false, reason: 'Not the coin it says it is' });
    await refused.site.connect(SITE);
    await expect(refused.site.signEvm(SITE, req)).rejects.toEqual(
      new TradeError('blocked', 'Not the coin it says it is'),
    );
    expect(refused.state.opened).toBe(1);

    const { site, state } = setup(undefined, { ok: true, summary: 'Create CTEST on Klik', usd: 0 });
    await site.connect(SITE);
    state.answer = false;
    await expect(site.signEvm(SITE, req)).rejects.toEqual(new SiteError('rejected'));
    state.answer = true;
    await expect(site.signEvm(SITE, req)).resolves.toHaveProperty('signature');
    expect(state.opened).toBe(3);
  });

  it("bridges to the user's own wallet as it buys: asking only past their thresholds", async () => {
    const { site, state, bridge } = setup();
    await expect(site.bridge(SITE, BRIDGE)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    await expect(site.bridge(SITE, BRIDGE)).resolves.toMatchObject({
      id: 't-0.01',
      status: 'working',
      relayStatus: 'pending',
    });
    expect(state.opened).toBe(1);
    expect(bridge.send).toHaveBeenLastCalledWith({
      ...BRIDGE,
      confirmed: true,
      passwordChecked: false,
    });
    // $30 is above the $20 to confirm.
    state.bridgeUsd = 30;
    state.answer = false;
    await expect(site.bridge(SITE, BRIDGE)).rejects.toEqual(new SiteError('rejected'));
    expect(state.views.at(-1)).toMatchObject({
      kind: 'bridge',
      summary: '0.01 ETH on Base',
      receive: '3.21 SOL on Solana',
      recipient: WALLET,
      recipientName: 'Main',
      needsPassword: false,
      why: 'Above your confirmation amount ($20).',
    });
    expect(bridge.send).toHaveBeenCalledTimes(1);
    // So is a value nobody knows.
    state.bridgeUsd = null;
    await expect(site.bridge(SITE, BRIDGE)).rejects.toEqual(new SiteError('rejected'));
    expect(state.views.at(-1)).toMatchObject({ why: 'Its dollar value is unknown.' });
  });

  it('counts bridges into the minute budget with buys', async () => {
    const { site, state } = setup({ ok: true, summary: 'Buy', usd: 15 });
    await site.connect(SITE);
    state.bridgeUsd = 15;
    await site.signSolana(SITE, sign());
    await site.bridge(SITE, BRIDGE);
    await site.signSolana(SITE, sign());
    expect(state.opened).toBe(1);
    state.answer = false;
    await expect(site.bridge(SITE, BRIDGE)).rejects.toEqual(new SiteError('rejected'));
    expect(state.views.at(-1)).toMatchObject({
      why: 'Over $50 of buys and bridges from this site within a minute.',
    });
  });

  it('always asks before bridging to an outside address, with the password above the confirmation amount', async () => {
    const { site, state, bridge } = setup();
    await site.connect(SITE);
    const out = { ...BRIDGE, toWalletId: undefined, toAddress: STRANGER };
    await expect(site.bridge(SITE, out)).resolves.toHaveProperty('id');
    expect(state.opened).toBe(2);
    expect(state.views.at(-1)).toMatchObject({
      recipient: STRANGER,
      recipientName: null,
      needsPassword: false,
      why: null,
    });
    expect(bridge.send).toHaveBeenLastCalledWith({
      ...out,
      confirmed: true,
      passwordChecked: false,
    });

    // $30: the window takes the password, and a wrong one leaves the request open.
    state.bridgeUsd = 30;
    state.answer = null;
    const asking = site.bridge(SITE, out);
    await vi.waitFor(() => expect(state.opened).toBe(3));
    expect(state.views.at(-1)).toMatchObject({ needsPassword: true });
    await expect(site.decide('req-3', true, 'wrong password')).rejects.toEqual(
      new VaultError('bad_password'),
    );
    await expect(site.decide('req-3', true)).rejects.toEqual(new VaultError('bad_password'));
    expect(site.pendingView('req-3')).not.toBeNull();
    await site.decide('req-3', true, PASSWORD);
    await expect(asking).resolves.toHaveProperty('id');
    expect(bridge.send).toHaveBeenLastCalledWith({
      ...out,
      confirmed: true,
      passwordChecked: true,
    });

    // Declining needs no password.
    const declined = site.bridge(SITE, out);
    await vi.waitFor(() => expect(state.opened).toBe(4));
    await site.decide('req-4', false);
    await expect(declined).rejects.toEqual(new SiteError('rejected'));
    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it("treats an address typed that is one of the user's wallets as theirs", async () => {
    const { site, state } = setup();
    await site.connect(SITE);
    await site.bridge(SITE, { ...BRIDGE, toWalletId: undefined, toAddress: WALLET });
    expect(state.opened).toBe(1);
  });

  it('lets each site follow only the bridges it started', async () => {
    const { site } = setup();
    await site.connect(SITE);
    const { id } = await site.bridge(SITE, BRIDGE);
    expect(site.bridgeStatus(SITE, id)).toEqual({
      status: 'working',
      relayStatus: 'pending',
      deposit: `0x${'ab'.repeat(32)}`,
    });
    expect(site.bridgeStatus(OTHER, id)).toBeNull();
    expect(site.bridgeStatus(SITE, 'unknown')).toBeNull();
    const t = bridgeTicket(id);
    site.noteTicket({
      ...t,
      status: 'done',
      bridge: { ...t.bridge!, relayStatus: 'success', outHash: 'payout-signature' },
    });
    expect(site.bridgeStatus(SITE, id)).toMatchObject({
      status: 'done',
      relayStatus: 'success',
      payout: 'payout-signature',
    });
  });
});

describe("the Nesty website's trades", () => {
  const PREFS = {
    chain: { slippageBps: 2000, priority: 'high' as const },
    global: { jitterMaxMs: 50 },
  };
  const buy = (): RequestOf<'site.trade.buy'> => ({
    type: 'site.trade.buy',
    chainId: 8453,
    token: TOKEN,
    amount: '0.01',
    walletIds: ['w2'],
    mode: 'each',
    clickedAt: 999_000,
    prefs: PREFS,
  });
  const sell = (): RequestOf<'site.trade.sell'> => ({
    type: 'site.trade.sell',
    chainId: 8453,
    token: TOKEN,
    bps: 5000,
    walletIds: ['w2'],
    prefs: PREFS,
  });

  it('are made by the extension with the site’s settings, for a site that is in and unlocked', async () => {
    const { site, state, engine } = setup();
    expect((await site.hello(SITE)).trades).toBe(true);
    await expect(site.buy(SITE, buy(), 7)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    state.unlocked = false;
    await expect(site.buy(SITE, buy(), 7)).rejects.toEqual(new VaultError('locked'));
    await expect(site.sell(SITE, sell(), 7)).rejects.toEqual(new VaultError('locked'));
    state.unlocked = true;
    const t = await site.buy(SITE, buy(), 7);
    expect(t.id).toBe('buy-1');
    expect(engine.buy).toHaveBeenCalledWith(
      {
        chainId: 8453,
        token: TOKEN,
        amount: '0.01',
        walletIds: ['w2'],
        mode: 'each',
        confirmed: false,
        clickedAt: 999_000,
        prefs: PREFS,
        gate: expect.any(Function),
      },
      7,
    );
    // Only the connection was ever put to the user.
    expect(state.opened).toBe(1);
  });

  it('wait for the user above the confirmation amount, as the buys it signs do', async () => {
    const { site, state } = setup();
    await site.connect(SITE);
    state.buyUsd = 30;
    state.answer = false;
    await expect(site.buy(SITE, buy())).rejects.toEqual(new SiteError('rejected'));
    state.answer = true;
    await expect(site.buy(SITE, buy())).resolves.toHaveProperty('id');
    expect(state.opened).toBe(3);
    expect(state.views.at(-1)).toMatchObject({
      kind: 'trade',
      origin: SITE,
      walletName: 'Base',
      summary: 'Buy COIN for 0.01 ETH on Base',
      usd: 30,
    });
  });

  it('ask once buys pass the minute budget, and never for sells', async () => {
    const { site, state, engine } = setup();
    await site.connect(SITE);
    state.buyUsd = 15;
    // $15 each, $50 a minute (the defaults): the fourth would make $60.
    for (let i = 0; i < 3; i++) await site.buy(SITE, buy());
    expect(state.opened).toBe(1);
    state.answer = false;
    await expect(site.buy(SITE, buy())).rejects.toEqual(new SiteError('rejected'));
    expect(state.opened).toBe(2);
    await site.sell(SITE, sell());
    expect(state.opened).toBe(2);
    expect(engine.sell).toHaveBeenCalledWith(
      {
        chainId: 8453,
        token: TOKEN,
        bps: 5000,
        walletIds: ['w2'],
        confirmed: true,
        clickedAt: undefined,
        prefs: PREFS,
      },
      undefined,
    );
    // A minute later the budget is back.
    state.now += 61_000;
    await site.buy(SITE, buy());
    expect(state.opened).toBe(2);
  });

  it("tell the asking site's tab alone how its trades go, and replace only its own", async () => {
    const { site, engine, pushed } = setup();
    await site.connect(SITE);
    await site.connect(OTHER);
    const t = await site.buy(SITE, buy(), 7);
    site.noteTicket({ ...t, status: 'done' });
    site.noteTicket(tradeTicket('not-the-site', 8453));
    expect(pushed).toEqual([[7, t.id, 'done']]);

    const replace = (mode: 'speedUp' | 'cancel'): RequestOf<'site.trade.replace'> => ({
      type: 'site.trade.replace',
      ticketId: t.id,
      walletId: 'w2',
      mode,
    });
    await expect(site.replace(OTHER, replace('speedUp'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await site.replace(SITE, replace('cancel'));
    expect(engine.replace).toHaveBeenCalledWith(t.id, 'w2', 'cancel');

    // Turned off, it hears no more of them.
    await site.disconnect(SITE);
    site.noteTicket(t);
    expect(pushed).toHaveLength(1);
  });

  it("quote for the site's wallets, and buy on Solana on a pool the page named", async () => {
    const { site, quotes, sol } = setup();
    const ask: RequestOf<'site.trade.quotes'> = {
      type: 'site.trade.quotes',
      chainId: 8453,
      token: TOKEN,
      buyAmounts: ['0.01'],
      sellBps: [5000],
      walletIds: ['w2'],
    };
    await expect(site.quotes(SITE, ask)).rejects.toEqual(new SiteError('not_connected'));
    await site.connect(SITE);
    await site.quotes(SITE, ask);
    expect(quotes).toHaveBeenCalledWith({
      chainId: 8453,
      token: TOKEN,
      buyAmounts: ['0.01'],
      sellBps: [5000],
      walletIds: ['w2'],
    });

    const prefs = { solana: { slippageBps: 1500 } };
    await site.solBuy(
      SITE,
      {
        type: 'site.sol.buy',
        mint: WALLET,
        amount: '0.1',
        walletIds: ['w1'],
        mode: 'split',
        prefs,
        pool: STRANGER,
      },
      7,
    );
    expect(sol.notePagePool).toHaveBeenCalledWith(WALLET, STRANGER);
    expect(sol.buy).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: WALLET,
        amount: '0.1',
        mode: 'split',
        confirmed: false,
        prefs,
      }),
      7,
    );
    await site.solSell(SITE, {
      type: 'site.sol.sell',
      mint: WALLET,
      bps: 10_000,
      walletIds: ['w1'],
      prefs,
    });
    expect(sol.sell).toHaveBeenCalledWith(
      expect.objectContaining({ mint: WALLET, bps: 10_000, confirmed: true, prefs }),
      undefined,
    );
    sol.notePagePool.mockClear();
    await site.solQuotes(SITE, {
      type: 'site.sol.quotes',
      mint: WALLET,
      buyAmounts: ['0.1'],
      sellBps: [],
      walletIds: ['w1'],
    });
    expect(sol.panelQuotes).toHaveBeenCalledWith({
      mint: WALLET,
      buyAmounts: ['0.1'],
      sellBps: [],
      walletIds: ['w1'],
    });
    expect(sol.notePagePool).not.toHaveBeenCalled();
    // A quick buy's new curve is noted before it is quoted, as for the buy itself.
    await site.solQuotes(SITE, {
      type: 'site.sol.quotes',
      mint: WALLET,
      buyAmounts: ['0.1'],
      sellBps: [],
      walletIds: ['w1'],
      pool: STRANGER,
    });
    expect(sol.notePagePool).toHaveBeenCalledWith(WALLET, STRANGER);
  });
});
