import {
  decodeFunctionData,
  encodeFunctionData,
  pad,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import { BridgeFlow } from '../src/background/trade/engine/bridge';
import { EngineCore, type EngineDeps } from '../src/background/trade/engine/core';
import { RELAY_DEPOSITORY, type RelayClient } from '../src/background/trade/relay';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { TradeTicket } from '../src/shared/panel';
import type { WalletAccount } from '../src/shared/wallet';

// A bridge out of Elysium, where Relay holds no HYPE: HYPE → USDC on a pool, the exact
// approval, then the USDC deposit. The pool, the RPC and Relay are made up; the engine and
// its checks are the real ones.

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

const ELYSIUM = 99901;
const USDC: Address = '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65';
// Made-up addresses for these tests only.
const ME: Address = '0x1111111111111111111111111111111111111111';
const POOL_ROUTER: Address = '0x5555555555555555555555555555555555555555';
const ID: Hex = `0x${'ab'.repeat(32)}`;
const REQUEST_ID: Hex = `0x${'17'.repeat(32)}`;
const PAYOUT: Hex = `0x${'cd'.repeat(32)}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** 0.25 HYPE at $40: $10, under the default limits ($25 a transaction, confirm above $20). */
const AMOUNT = parseEther('0.25');
const HYPE_USD = 40;
/** The pool's quote for it, 0.5% off the price, and what the swap then delivered. */
const QUOTED = 9_950_000n;
const ARRIVED = 9_940_000n;
/** Relay's rate: wei of ETH on Base per USDC unit. */
const RATE = 322_000_000n;

const abi = parseAbi([
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
  'function approve(address spender, uint256 amount)',
]);
const depositErc20 = (amount: bigint) =>
  encodeFunctionData({ abi, functionName: 'depositErc20', args: [ME, USDC, amount, ID] });

const req = {
  fromChainId: ELYSIUM,
  toChainId: 8453,
  amount: '0.25',
  fromWalletId: 'main',
  toWalletId: 'main',
};

interface Opts {
  balance?: bigint;
  allowance?: bigint;
  quoted?: bigint;
  /** Relay's answers in turn: a quote, or this error. */
  relay?: ('ok' | Error)[];
}

function setup(o: Opts = {}) {
  const sent: { to: Address; data: Hex; value: bigint }[] = [];
  const asked: bigint[] = [];
  const tickets: TradeTicket[] = [];
  const answers = [...(o.relay ?? [])];

  // Each transaction's hash is its index among those sent.
  const receipt = (hash: Hash) => {
    const tx = sent[Number(BigInt(hash))];
    const logs =
      tx?.to === POOL_ROUTER
        ? [
            {
              address: USDC,
              topics: [TRANSFER, pad(POOL_ROUTER), pad(ME)],
              data: toHex(ARRIVED, { size: 32 }),
            },
          ]
        : [];
    return { status: 'success', logs, gasUsed: 100_000n, effectiveGasPrice: 500_000_000n };
  };
  const client = {
    estimateGas: async () => 150_000n,
    getBalance: async () => o.balance ?? parseEther('1'),
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => receipt(hash),
    waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => receipt(hash),
    readContract: async () => o.allowance ?? 0n,
    getTransactionCount: async () => 0,
  } as unknown as PublicClient;

  const venue = {
    id: 'test-pool',
    // The swap's minimum rides in its data, to be read back below.
    buildBuy: (_ctx: unknown, _pool: unknown, p: { amountIn: bigint; minOut: bigint }) => ({
      to: POOL_ROUTER,
      data: toHex(p.minOut, { size: 32 }),
      value: p.amountIn,
    }),
  };
  const pool = { venueId: venue.id, id: 'hype-usdc', label: 'Test pool', token: USDC, data: null };
  const relay: RelayClient = {
    quote: () => Promise.reject(new Error('HYPE itself is never deposited')),
    quoteToken: async (p) => {
      asked.push(p.amount);
      const a = answers.shift() ?? 'ok';
      if (a instanceof Error) throw a;
      const amountOut = p.amount * RATE;
      return {
        amountIn: p.amount,
        amountOut,
        minOut: (amountOut * 9_950n) / 10_000n,
        feeUsd: 0.05,
        timeEstimateS: 2,
        requestId: REQUEST_ID,
        statusPath: `/intents/status?requestId=${REQUEST_ID}`,
        token: p.token,
        tx: { to: RELAY_DEPOSITORY, data: depositErc20(p.amount), value: 0n },
      };
    },
    quoteFromSolana: () => Promise.reject(new Error('EVM only')),
    status: async () => ({ status: 'success', outHash: PAYOUT }),
  };
  const wallet: WalletAccount = {
    id: 'main',
    name: 'main',
    hidden: false,
    primary: true,
    kind: 'derived',
    address: ME,
  };
  let nonce = 0;
  const deps = {
    vault: { listAccounts: async () => [wallet] },
    signer: {
      transaction: async (_w: unknown, tx: { to: Address; data: Hex; value: bigint }) => {
        sent.push({ to: tx.to, data: tx.data, value: tx.value });
        return toHex(sent.length - 1, { size: 32 });
      },
      permit: () => Promise.reject(new Error('no permits here')),
    },
    settings: new SettingsStore(new MemoryStore()),
    routing: {
      best: async (_ctx: unknown, _token: Address, _side: string, amounts: bigint[]) =>
        amounts.map(() => ({ pool, venue, out: o.quoted ?? QUOTED })),
      venue: (id: string) => (id === venue.id ? venue : undefined),
    },
    fees: {
      fees: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000n }),
      baseFee: async () => 500_000_000n,
    },
    nonces: {
      signAndSend: async (
        _chainId: number,
        _from: Address,
        sign: (n: number) => Promise<Hex>,
        send: (raw: Hex) => Promise<Hash>,
      ) => {
        const n = nonce++;
        return { nonce: n, result: await send(await sign(n)) };
      },
      reset: () => undefined,
    },
    prices: { nativeUsd: async () => HYPE_USD },
    client: () => client,
    broadcast: async (_chain: unknown, _cs: unknown, raw: Hex) => raw,
    // The made-up pool's router passes as a contract Nesty knows.
    extraContracts: () =>
      new Map([
        [
          POOL_ROUTER.toLowerCase(),
          { label: 'Test pool', validate: () => [{ label: 'Swap', ok: true }] },
        ],
      ]),
    notify: (t: TradeTicket) => void tickets.push(t),
    relay,
    nextBlock: async () => undefined,
    now: () => Date.now(),
  } as unknown as EngineDeps;
  const flow = new BridgeFlow(new EngineCore(deps));
  const latest = () => tickets[tickets.length - 1];
  /** Runs the flow on until `done` says so, in fake time (Relay is asked every 3 s). */
  const until = async (done: (t: TradeTicket) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const t = latest();
      if (t && done(t)) return t;
      await vi.advanceTimersByTimeAsync(25);
    }
    throw new Error(`flow stalled: ${JSON.stringify(latest()?.legs)}`);
  };
  return { flow, sent, asked, latest, until };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bridging out of a chain whose coin the bridge does not hold', () => {
  it('swaps, approves exactly what arrived, deposits that, and follows the payout', async () => {
    const { flow, sent, asked, until } = setup();
    const started = await flow.bridge({ ...req, confirmed: false });
    // The deposit stays the first leg; the swap is a step behind it.
    expect(started.legs.map((l) => [l.kind, l.note])).toEqual([
      ['bridge', undefined],
      ['step', 'HYPE → USDC'],
    ]);
    const t = await until((x) => x.bridge?.relayStatus === 'success');

    expect(sent.map((s) => s.to)).toEqual([POOL_ROUTER, USDC, RELAY_DEPOSITORY]);
    // The swap: the whole amount in, 1% below the pool's quote at least out.
    expect(sent[0]).toMatchObject({ value: AMOUNT, data: toHex(9_850_500n, { size: 32 }) });
    expect(decodeFunctionData({ abi, data: sent[1]!.data }).args).toEqual([
      RELAY_DEPOSITORY,
      ARRIVED,
    ]);
    expect(sent[2]).toEqual({ to: RELAY_DEPOSITORY, data: depositErc20(ARRIVED), value: 0n });
    // Quoted before anything was sent, then again for exactly what the swap delivered.
    expect(asked).toEqual([QUOTED, ARRIVED]);

    expect(t.status).toBe('done');
    expect(t.bridge).toMatchObject({
      amountOut: (ARRIVED * RATE).toString(),
      outHash: PAYOUT,
      requestId: REQUEST_ID,
    });
    expect(t.legs.map((l) => [l.kind, l.status])).toEqual([
      ['bridge', 'confirmed'],
      ['step', 'confirmed'],
      ['approve', 'confirmed'],
    ]);
    expect(t.legs[0]!.hash).toBe(toHex(2, { size: 32 }));
  });

  it('skips the approval when the depository may already take it', async () => {
    const { flow, sent, until } = setup({ allowance: ARRIVED });
    await flow.bridge({ ...req, confirmed: false });
    const t = await until((x) => x.status !== 'working');
    expect(sent.map((s) => s.to)).toEqual([POOL_ROUTER, RELAY_DEPOSITORY]);
    expect(t.legs.map((l) => l.kind)).toEqual(['bridge', 'step']);
  });

  it('swaps nothing when the bridge refuses up front', async () => {
    const { flow, sent } = setup({ relay: [new Error('Bridge service: amount too low')] });
    await expect(flow.bridge({ ...req, confirmed: false })).rejects.toMatchObject({
      code: 'no_route',
      detail: 'Bridge service: amount too low',
    });
    expect(sent).toEqual([]);
  });

  it('swaps nothing when the wallet cannot also pay the approval and the deposit', async () => {
    // Enough for the swap and its own gas, not for the two transactions after it.
    const { flow, sent, until } = setup({ balance: AMOUNT + parseEther('0.0003') });
    await flow.bridge({ ...req, confirmed: false });
    const t = await until((x) => x.status !== 'working');
    expect(sent).toEqual([]);
    expect(t.status).toBe('failed');
    expect(t.legs[0]!.error).toMatch(/gas for the swap, approval and deposit/);
  });

  it('says the USDC stays in the wallet when the bridge refuses after the swap', async () => {
    const { flow, sent, until } = setup({
      relay: ['ok', new Error('Bridge service: route paused')],
    });
    await flow.bridge({ ...req, confirmed: false });
    const t = await until((x) => x.status !== 'working');
    expect(sent.map((s) => s.to)).toEqual([POOL_ROUTER]);
    // Failed, not part done: a bridge is its deposit.
    expect(t.status).toBe('failed');
    expect(t.legs[0]).toMatchObject({ kind: 'bridge', status: 'failed' });
    expect(t.legs[0]!.error).toMatch(/route paused.*9\.94 USDC stays in your wallet/);
  });

  it('refuses a swap that gives up more than 3% against the price', async () => {
    // 9 USDC for $10 of HYPE.
    const { flow, sent } = setup({ quoted: 9_000_000n });
    await expect(flow.bridgeQuote(req)).rejects.toThrow();
    await expect(flow.bridge({ ...req, confirmed: false })).rejects.toMatchObject({
      code: 'no_route',
      detail: expect.stringMatching(/costs more than 3%/),
    });
    expect(sent).toEqual([]);
  });

  it('quotes the payout with both slippages and the swap in the fee', async () => {
    const { flow } = setup();
    const q = await flow.bridgeQuote(req);
    const relayMin = (QUOTED * RATE * 9_950n) / 10_000n;
    expect(q).toMatchObject({
      amountOut: (QUOTED * RATE).toString(),
      // Relay's least for the swap's least (1% below its quote).
      minOut: ((relayMin * 9_850_500n) / QUOTED).toString(),
      slippageBps: 150,
      timeEstimateS: 6,
      amountInUsd: 10,
    });
    // Relay's $0.05 and the swap's $0.05 below the price.
    expect(q.feeUsd).toBeCloseTo(0.1);
  });
});
