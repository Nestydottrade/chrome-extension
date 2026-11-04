import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import { SYSTEM_PROGRAM } from '../src/background/solana/address';
import { publicKeyOf } from '../src/background/solana/keys';
import { relayDepositNative } from '../src/background/solana/relay';
import type { AccountInfo } from '../src/background/solana/rpc';
import { SolanaService } from '../src/background/solana/service';
import { setComputeUnitLimit, setComputeUnitPrice, transfer } from '../src/background/solana/spl';
import { networkFee } from '../src/background/solana/transfers';
import type { Instruction } from '../src/background/solana/tx';
import { validateRelayDeposit, type RelayDepositContext } from '../src/background/solana/validator';
import type { RelayClient, SolBridgeQuote } from '../src/background/trade/relay';
import { VaultError, type KeyValueStore } from '../src/background/vault/vault';
import type { TradeTicket } from '../src/shared/panel';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';
import type { WalletAccount } from '../src/shared/wallet';

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

const ME = publicKeyOf(new Uint8Array(32).fill(1));
const OTHER = publicKeyOf(new Uint8Array(32).fill(3));
const EVM_ME: Address = '0x1111111111111111111111111111111111111111';
const DEPOSIT_ID = new Uint8Array(32).fill(0xbb);
const REQUEST_ID: Hex = `0x${'17'.repeat(32)}`;
const SOL = 1_000_000_000n;
/** A wallet's rent exemption on mainnet in October 2026: (128 + 0 bytes) × 5,080 lamports. */
const MIN = 650_240n;
// Made up for the tests, like the keys above.
const PASSWORD = 'Correct horse battery 9!';
const EVM_STRANGER: Address = '0x3333333333333333333333333333333333333333';

describe('Relay deposit validator (Solana)', () => {
  const ctx: RelayDepositContext = {
    wallet: ME,
    amount: SOL / 10n,
    id: DEPOSIT_ID,
    maxSpend: SOL,
    maxPriorityLamports: 1_000_000n,
  };
  const budget = [setComputeUnitLimit(20_000), setComputeUnitPrice(1_000n)];
  const deposit = relayDepositNative(ME, SOL / 10n, DEPOSIT_ID);
  const reasons = (ixs: Instruction[], over: Partial<RelayDepositContext> = {}) =>
    validateRelayDeposit(ixs, { ...ctx, ...over })
      .actions.filter((a) => !a.ok)
      .map((a) => a.reason);

  it('allows exactly the deposit quoted, with its compute budget', () => {
    expect(reasons([...budget, deposit])).toEqual([]);
    expect(validateRelayDeposit([...budget, deposit], ctx).actions.map((a) => a.label)).toContain(
      'Bridge deposit of 0.1 SOL',
    );
  });

  it('blocks anything next to it, or a second deposit', () => {
    expect(reasons([...budget, deposit, transfer(ME, OTHER, 1n)])).toEqual([
      'Program is not on the allowlist',
    ]);
    expect(reasons([...budget, deposit, deposit])).toEqual(['Exactly one deposit per transaction']);
    expect(reasons(budget)).toEqual(['Exactly one deposit per transaction']);
  });

  it('blocks a deposit of another amount, for another request, or for someone else', () => {
    expect(reasons([relayDepositNative(ME, SOL / 10n + 1n, DEPOSIT_ID)])).toEqual([
      'Not the deposit you asked for',
    ]);
    expect(reasons([relayDepositNative(ME, SOL / 10n, new Uint8Array(32).fill(1))])).toEqual([
      'Not the deposit you asked for',
    ]);
    const credited = {
      ...deposit,
      keys: deposit.keys.map((k, i) => (i === 2 ? { ...k, pubkey: OTHER } : k)),
    };
    expect(reasons([credited])).toEqual(['Deposit is not credited to the sending wallet']);
    // Paid by another signer: only the wallet may sign.
    expect(reasons([relayDepositNative(OTHER, SOL / 10n, DEPOSIT_ID)], {})).toContain(
      'Only your wallet may sign',
    );
  });

  it('applies the per-transaction limit and the max network fee', () => {
    expect(reasons([deposit], { maxSpend: SOL / 10n - 1n })).toEqual([
      'Above your per-transaction limit',
    ]);
    // 1,000,000 µlamports × 20,000 units: 20,000 lamports.
    expect(
      reasons([setComputeUnitLimit(20_000), setComputeUnitPrice(1_000_000n), deposit], {
        maxPriorityLamports: 19_999n,
      }),
    ).toEqual(['Above your max network fee']);
  });
});

describe('Bridging from Solana', () => {
  const wallet = (id: string, keys: { solana?: string; address?: Address }): WalletAccount => ({
    id,
    name: id,
    hidden: false,
    primary: id === 'main',
    kind: 'derived',
    ...keys,
  });
  const accounts: WalletAccount[] = [
    wallet('main', { solana: ME, address: EVM_ME }),
    wallet('sol', { solana: OTHER }),
    wallet('evm', { address: '0x2222222222222222222222222222222222222222' }),
  ];
  const SOL_TO_BASE = {
    fromChainId: SOLANA_CHAIN_ID,
    toChainId: 8453,
    fromWalletId: 'main',
    toWalletId: 'main',
  };

  /** SOL at $150, the default limits ($25 a transaction, confirm above $20), these balances. */
  async function setup(balances: Record<string, bigint>, tokenAt: string | null = null) {
    const settings = new SettingsStore(new MemoryStore());
    const asked: unknown[] = [];
    const relay: RelayClient = {
      quote: () => Promise.reject(new Error('EVM only')),
      quoteFromSolana: async (p): Promise<SolBridgeQuote> => {
        asked.push(p);
        return {
          amountIn: p.amount,
          amountOut: 4_000_000_000_000_000n,
          minOut: 3_980_000_000_000_000n,
          feeUsd: 0.04,
          timeEstimateS: 2,
          requestId: REQUEST_ID,
          statusPath: `/intents/status?requestId=${REQUEST_ID}`,
          depositId: DEPOSIT_ID,
        };
      },
      status: async () => ({ status: 'pending' }),
    };
    const tickets: TradeTicket[] = [];
    const svc = new SolanaService({
      vault: {
        listAccounts: async () => accounts,
        verifyPassword: async (password: string) => {
          if (password !== PASSWORD) throw new VaultError('bad_password');
        },
      } as never,
      settings,
      local: new MemoryStore(),
      history: { list: async () => [] },
      notify: (t) => void tickets.push(t),
      relay,
      evmTokenAt: async () => tokenAt,
      now: Date.now,
    });
    const info = (lamports: bigint): AccountInfo => ({
      owner: SYSTEM_PROGRAM,
      lamports,
      data: new Uint8Array(0),
      executable: false,
    });
    // Reads only: nothing is signed or sent (the blockhash never comes).
    svc.rpcFor = () =>
      ({
        getBalance: async (a: string) => balances[a] ?? 0n,
        getAccount: async (a: string) => (balances[a] !== undefined ? info(balances[a]) : null),
        minimumBalance: async (size: number) => BigInt(128 + size) * 5_080n,
        getLatestBlockhash: () => Promise.reject(new Error('offline')),
      }) as never;
    Object.assign(svc, { price: { usd: async () => 150 } });
    return { svc, asked, tickets, fee: networkFee(await settings.getSolana()) };
  }

  it('quotes a deposit from the Solana address to the EVM address of the wallets picked', async () => {
    const { svc, asked } = await setup({ [ME]: SOL });
    const q = await svc.bridge.quote({ ...SOL_TO_BASE, amount: '0.1' });
    expect(asked).toEqual([{ user: ME, recipient: EVM_ME, toChainId: 8453, amount: SOL / 10n }]);
    expect(q).toMatchObject({
      amountOut: '4000000000000000',
      minOut: '3980000000000000',
      slippageBps: 50,
      amountInUsd: 15,
    });
  });

  it.each([
    ['to Solana', { toChainId: SOLANA_CHAIN_ID }, 'Pick two different chains.'],
    ['to an unknown chain', { toChainId: 999_999 }, undefined],
    ['with more than 9 decimals', { amount: '0.0000000001' }, 'SOL has at most 9 decimals.'],
    [
      'from a wallet without a Solana address',
      { fromWalletId: 'evm' },
      'evm has no Solana address.',
    ],
    ['to a wallet without an EVM address', { toWalletId: 'sol' }, 'sol has no EVM address.'],
  ] as const)('refuses a bridge %s', async (_name, over, detail) => {
    const { svc } = await setup({ [ME]: SOL });
    const req = { ...SOL_TO_BASE, amount: '0.1', ...over };
    await expect(svc.bridge.quote(req)).rejects.toMatchObject(detail ? { detail } : {});
    await expect(svc.bridge.bridge({ ...req, confirmed: true })).rejects.toThrow();
  });

  it('applies the USD limits', async () => {
    const { svc } = await setup({ [ME]: SOL });
    // 0.2 SOL is $30: above the $25 limit. 0.15 SOL is $22.50: above the $20 to confirm.
    await expect(
      svc.bridge.bridge({ ...SOL_TO_BASE, amount: '0.2', confirmed: true }),
    ).rejects.toMatchObject({ code: 'limit_exceeded', detail: '30.00 > 25 per transaction.' });
    await expect(
      svc.bridge.bridge({ ...SOL_TO_BASE, amount: '0.15', confirmed: false }),
    ).rejects.toMatchObject({ code: 'needs_confirmation', detail: '22.50' });
  });

  it('leaves the wallet empty or able to exist', async () => {
    const { fee } = await setup({});
    const amount = SOL / 10n;
    const bridge = async (balance: bigint) =>
      (await setup({ [ME]: balance })).svc.bridge.bridge({
        ...SOL_TO_BASE,
        amount: '0.1',
        confirmed: true,
      });
    await expect(bridge(amount + fee - 1n)).rejects.toMatchObject({
      detail: 'Amount plus fee is more than the balance.',
    });
    await expect(bridge(amount + fee + MIN - 1n)).rejects.toMatchObject({
      detail:
        'Send everything, or leave at least 0.00065024 SOL: Solana closes a wallet below that.',
    });
    expect((await bridge(amount + fee)).legs[0]?.status).toBe('queued');
    expect((await bridge(amount + fee + MIN)).legs[0]?.status).toBe('queued');
  });

  it('opens a bridge ticket, and the deposit it builds passes the validator', async () => {
    const { svc, tickets } = await setup({ [ME]: SOL });
    const t = await svc.bridge.bridge({ ...SOL_TO_BASE, amount: '0.1', confirmed: true });
    expect(t).toMatchObject({
      kind: 'bridge',
      chainId: SOLANA_CHAIN_ID,
      nativeUsd: 150,
      bridge: {
        toChainId: 8453,
        amountIn: '100000000',
        amountOut: '4000000000000000',
        recipientName: 'main',
        requestId: REQUEST_ID,
        relayStatus: 'waiting',
      },
    });
    expect(t.legs).toMatchObject([{ walletId: 'main', kind: 'bridge', amountIn: '100000000' }]);
    // Checked, then stopped where the network starts: no blockhash comes here.
    await new Promise((r) => setTimeout(r, 20));
    expect(tickets.at(-1)?.legs[0]).toMatchObject({ status: 'failed', error: 'offline' });
  });

  it('is done once Relay paid out, not when the deposit lands', async () => {
    const { svc, tickets } = await setup({});
    const st = svc.newTicket('bridge', [
      { walletId: 'main', walletName: 'main', kind: 'bridge', status: 'confirmed' },
    ]);
    st.ticket.bridge = {
      toChainId: 8453,
      amountIn: '1',
      amountOut: '1',
      recipientName: 'main',
      requestId: REQUEST_ID,
      relayStatus: 'pending',
    };
    const statusAt = (relayStatus: string) => {
      st.ticket.bridge!.relayStatus = relayStatus;
      svc.update(st);
      return tickets.at(-1)?.status;
    };
    expect(statusAt('pending')).toBe('working');
    expect(statusAt('refund')).toBe('failed');
    expect(statusAt('failure')).toBe('failed');
    expect(statusAt('success')).toBe('done');
  });

  it('tells bridges to Solana when a new wallet would be paid too little to exist', async () => {
    const { svc } = await setup({ [OTHER]: MIN });
    expect(await svc.bridge.payoutBlock(ME, MIN - 1n)).toBe(
      'A new Solana wallet needs at least 0.00065024 SOL to exist: bridge a little more.',
    );
    expect(await svc.bridge.payoutBlock(ME, MIN)).toBeNull();
    // A wallet that exists may receive any amount.
    expect(await svc.bridge.payoutBlock(OTHER, 1n)).toBeNull();
  });

  it('pays an outside address, as a Send: the password above the confirmation amount', async () => {
    const { svc, asked } = await setup({ [ME]: SOL });
    const out = { ...SOL_TO_BASE, toWalletId: undefined, toAddress: EVM_STRANGER };
    // 0.1 SOL is $15: below the $20 to confirm.
    const t = await svc.bridge.bridge({ ...out, amount: '0.1', confirmed: false });
    expect(asked.at(-1)).toMatchObject({ recipient: EVM_STRANGER });
    expect(t.bridge).toMatchObject({
      recipient: EVM_STRANGER,
      recipientName: '0x3333…3333',
      outside: true,
    });
    // 0.15 SOL is $22.50: the password, which no confirmation stands in for.
    const above = { ...out, amount: '0.15', confirmed: true };
    await expect(svc.bridge.bridge(above)).rejects.toMatchObject({
      code: 'needs_password',
      detail: '22.50',
    });
    await expect(svc.bridge.bridge({ ...above, password: 'wrong' })).rejects.toEqual(
      new VaultError('bad_password'),
    );
    await expect(svc.bridge.bridge({ ...above, password: PASSWORD })).resolves.toMatchObject({
      bridge: { outside: true },
    });
    // The website's approval window asked the password itself.
    await expect(svc.bridge.bridge({ ...above, passwordChecked: true })).resolves.toMatchObject({
      kind: 'bridge',
    });
  });

  it('never pays an outside address that is a token contract', async () => {
    const { svc } = await setup({ [ME]: SOL }, 'USDC');
    await expect(
      svc.bridge.quote({
        ...SOL_TO_BASE,
        toWalletId: undefined,
        toAddress: EVM_STRANGER,
        amount: '0.1',
      }),
    ).rejects.toMatchObject({
      code: 'blocked',
      detail: 'This is the USDC token contract: funds sent there are lost.',
    });
    // The user's own wallets are not looked up.
    await expect(svc.bridge.quote({ ...SOL_TO_BASE, amount: '0.1' })).resolves.toHaveProperty(
      'amountOut',
    );
  });
});
