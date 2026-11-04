import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROGRAM,
  addressBytes,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
} from '../src/background/solana/address';
import { publicKeyOf } from '../src/background/solana/keys';
import { EXT } from '../src/background/solana/layouts';
import { PUMP_PROGRAM, bondingCurveAddress } from '../src/background/solana/pump';
import {
  createAtaIdempotent,
  setComputeUnitLimit,
  setComputeUnitPrice,
  transfer,
  transferChecked,
} from '../src/background/solana/spl';
import { SettingsStore } from '../src/background/settings';
import type { AccountInfo } from '../src/background/solana/rpc';
import { SolanaService } from '../src/background/solana/service';
import {
  networkFee,
  recipientKind,
  sendBlock,
  solSendBlock,
  tokenAccountSize,
} from '../src/background/solana/transfers';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { WalletAccount } from '../src/shared/wallet';
import type { Instruction } from '../src/background/solana/tx';
import {
  validateSolanaTransfer,
  type SolTransferContext,
} from '../src/background/solana/validator';

/** A wallet's rent exemption on mainnet in October 2026: (128 + 0 bytes) × 5,080 lamports. */
const MIN = 650_240n;

// Made-up keys for these tests only. Never hold funds.
const WALLET = publicKeyOf(new Uint8Array(32).fill(1));
const FRIEND = publicKeyOf(new Uint8Array(32).fill(2));
const OTHER = publicKeyOf(new Uint8Array(32).fill(3));
const MINT = publicKeyOf(new Uint8Array(32).fill(4));

const budget = (ixs: Instruction[], lamportsPerMillionUnits = 1_000_000n) => [
  setComputeUnitLimit(100_000),
  setComputeUnitPrice(lamportsPerMillionUnits),
  ...ixs,
];

const solCtx = (amount: bigint, over: Partial<SolTransferContext> = {}): SolTransferContext => ({
  wallet: WALLET,
  to: FRIEND,
  asset: null,
  amount,
  maxPriorityLamports: 1_000_000n,
  ...over,
});

const tokenCtx = (
  amount: bigint,
  program = TOKEN_PROGRAM,
  over: Partial<SolTransferContext> = {},
): SolTransferContext => ({
  ...solCtx(amount),
  asset: { mint: MINT, program, decimals: 6, symbol: 'TEST' },
  ...over,
});

const tokenSend = (amount: bigint, program = TOKEN_PROGRAM, to = FRIEND, decimals = 6) => [
  createAtaIdempotent(to, MINT, program, WALLET),
  transferChecked(WALLET, to, MINT, program, amount, decimals),
];

const failures = (r: ReturnType<typeof validateSolanaTransfer>) =>
  r.actions.filter((a) => !a.ok).map((a) => a.reason);

describe('Solana transfer validator', () => {
  it('passes a SOL transfer and a token transfer on either token program', () => {
    expect(
      failures(validateSolanaTransfer(budget([transfer(WALLET, FRIEND, 5n)]), solCtx(5n))),
    ).toEqual([]);
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = validateSolanaTransfer(budget(tokenSend(7n, program)), tokenCtx(7n, program));
      expect(failures(r)).toEqual([]);
      expect(r.actions.map((a) => a.label)).toContain(
        `Send 0.000007 TEST to ${FRIEND.slice(0, 6)}…${FRIEND.slice(-4)}`,
      );
    }
    // The recipient's account may already exist: the transfer alone passes too.
    const plain = [transferChecked(WALLET, FRIEND, MINT, TOKEN_PROGRAM, 7n, 6)];
    expect(failures(validateSolanaTransfer(budget(plain), tokenCtx(7n)))).toEqual([]);
  });

  it('blocks anything but the transfer asked for', () => {
    const solBad = (ixs: Instruction[], ctx = solCtx(5n)) =>
      failures(validateSolanaTransfer(budget(ixs), ctx));
    expect(solBad([transfer(WALLET, FRIEND, 6n)])).toContain('Not the transfer you asked for');
    expect(solBad([transfer(WALLET, OTHER, 5n)])).toContain('Not the transfer you asked for');
    expect(solBad([transfer(WALLET, FRIEND, 5n), transfer(WALLET, FRIEND, 5n)])).toContain(
      'Exactly one transfer per transaction',
    );
    expect(solBad([])).toContain('Exactly one transfer per transaction');
    expect(solBad([transfer(OTHER, FRIEND, 5n)])).toContain('Only your wallet may sign');
    expect(solBad([transfer(WALLET, WALLET, 5n)], solCtx(5n, { to: WALLET }))).toContain(
      'This is the wallet you are sending from',
    );
    expect(
      solBad([
        transfer(WALLET, FRIEND, 5n),
        { programId: PUMP_PROGRAM, keys: [], data: new Uint8Array(8) },
      ]),
    ).toContain('Program is not on the allowlist');
    // A token transfer where SOL was asked for.
    expect(solBad(tokenSend(5n))).toContain('Not the transfer you asked for');

    const tokenBad = (ixs: Instruction[], ctx = tokenCtx(7n)) =>
      failures(validateSolanaTransfer(budget(ixs), ctx));
    expect(tokenBad(tokenSend(8n))).toContain('Not the transfer you asked for');
    expect(tokenBad(tokenSend(7n, TOKEN_PROGRAM, FRIEND, 9))).toContain(
      'Not the transfer you asked for',
    );
    expect(tokenBad(tokenSend(7n, TOKEN_2022_PROGRAM))).toEqual([
      "Not the recipient's account for this token",
      'Not the transfer you asked for',
    ]);
    expect(
      tokenBad([
        createAtaIdempotent(OTHER, MINT, TOKEN_PROGRAM, WALLET),
        tokenSend(7n)[1] as Instruction,
      ]),
    ).toContain("Not the recipient's account for this token");
    expect(tokenBad([transfer(WALLET, FRIEND, 7n)])).toContain('Not the transfer you asked for');
  });

  it('caps the priority fee', () => {
    // 100,000 units at 20,000,000 µlamports each: 2,000,000 lamports, above 1,000,000.
    const r = validateSolanaTransfer(
      budget([transfer(WALLET, FRIEND, 5n)], 20_000_000n),
      solCtx(5n),
    );
    expect(failures(r)).toEqual(['Above your max network fee']);
  });
});

describe('Solana recipients', () => {
  const account = (owner: string, data: Uint8Array, executable = false) => ({
    owner,
    lamports: 1n,
    data,
    executable,
  });

  it('tells wallets from programs, mints and token accounts', () => {
    expect(recipientKind(FRIEND, null).kind).toBe('unused');
    // A program-derived address has no key: only its program moves what it holds.
    expect(recipientKind(bondingCurveAddress(USDC_MINT), null).kind).toBe('program-account');
    expect(recipientKind(FRIEND, account(SYSTEM_PROGRAM, new Uint8Array(0))).kind).toBe('wallet');
    expect(recipientKind(PUMP_PROGRAM, account(OTHER, new Uint8Array(36), true)).kind).toBe(
      'program',
    );
    expect(recipientKind(WSOL_MINT, account(TOKEN_PROGRAM, new Uint8Array(82))).kind).toBe('mint');
    // Mint, then the owner: the wallet to send to instead.
    const tokenAccount = new Uint8Array(165);
    tokenAccount.set(addressBytes(USDC_MINT), 0);
    tokenAccount.set(addressBytes(FRIEND), 32);
    const ata = associatedTokenAddress(FRIEND, USDC_MINT, TOKEN_PROGRAM);
    expect(recipientKind(ata, account(TOKEN_PROGRAM, tokenAccount))).toEqual({
      kind: 'token-account',
      owner: FRIEND,
    });
    // Token-2022 accounts carry extensions after byte 165, with account type 2 there.
    const extended = new Uint8Array(175);
    extended[165] = 2;
    expect(recipientKind(ata, account(TOKEN_2022_PROGRAM, extended)).kind).toBe('token-account');
    const extendedMint = new Uint8Array(200);
    extendedMint[165] = 1;
    expect(recipientKind(MINT, account(TOKEN_2022_PROGRAM, extendedMint)).kind).toBe('mint');
    expect(recipientKind(OTHER, account(PUMP_PROGRAM, new Uint8Array(100))).kind).toBe(
      'program-account',
    );
  });

  it('knows the size of the token account it opens for the recipient', () => {
    expect(tokenAccountSize(TOKEN_PROGRAM)).toBe(165);
    // The account type and an ImmutableOwner entry.
    expect(tokenAccountSize(TOKEN_2022_PROGRAM, [EXT.metadataPointer, EXT.tokenMetadata])).toBe(
      170,
    );
    // A pausable token's accounts carry an entry of their own.
    expect(tokenAccountSize(TOKEN_2022_PROGRAM, [EXT.pausable])).toBe(174);
  });

  it('refuses tokens whose rules a plain transfer cannot follow', () => {
    const meta = (extensions: number[]) => ({
      name: 'Test',
      symbol: 'TEST',
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM,
      supply: 1n,
      extensions,
    });
    expect(sendBlock(meta([EXT.metadataPointer, EXT.tokenMetadata]))).toBeNull();
    expect(sendBlock(meta([EXT.transferHook]))).toMatch(/runs a program/);
    expect(sendBlock(meta([EXT.transferFeeConfig]))).toMatch(/takes a fee/);
    expect(sendBlock(meta([EXT.nonTransferable]))).toMatch(/cannot be transferred/);
  });
});

describe('Solana balances a transfer may leave', () => {
  const fee = 105_000n;

  it('allows a balance of zero or enough to exist, after the fee and after the transfer', () => {
    expect(solSendBlock(10_000_000n, 5_000_000n, fee, MIN)).toBeNull();
    // All of it: the fee leaves 9,895,000, which the transfer takes.
    expect(solSendBlock(10_000_000n, 10_000_000n - fee, fee, MIN)).toBeNull();
    expect(solSendBlock(10_000_000n, 10_000_000n - fee - MIN, fee, MIN)).toBeNull();
    expect(solSendBlock(10_000_000n, 10_000_000n - fee + 1n, fee, MIN)).toBe(
      'Amount plus fee is more than the balance.',
    );
    expect(solSendBlock(10_000_000n, 10_000_000n - fee - MIN + 1n, fee, MIN)).toMatch(
      /^Send everything, or leave at least 0.00065024 SOL/,
    );
    // The fee would leave 595,000: below what may exist, even with the transfer taking it all
    // (mainnet refuses that before running the transfer).
    expect(solSendBlock(700_000n, 595_000n, fee, MIN)).toBe(
      'Too little to empty this wallet: that takes at least 0.00075524 SOL.',
    );
    expect(solSendBlock(MIN + fee, MIN, fee, MIN)).toBeNull();
  });
});

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

describe('Solana distribute and collect', () => {
  const W1 = OTHER;
  const W2 = publicKeyOf(new Uint8Array(32).fill(5));
  const W3 = publicKeyOf(new Uint8Array(32).fill(6));
  const wallet = (id: string, solana?: string): WalletAccount => ({
    id,
    name: id,
    hidden: false,
    primary: id === 'hub',
    kind: 'derived',
    ...(solana ? { solana } : { address: '0x1111111111111111111111111111111111111111' }),
  });
  const accounts: WalletAccount[] = [
    wallet('hub', WALLET),
    wallet('w1', W1),
    wallet('w2', W2),
    wallet('w3', W3),
    wallet('evm'),
  ];
  const SOL = 1_000_000_000n;
  const sol = (lamports: bigint) => (Number(lamports) / 1e9).toString();

  /** SOL at $150, the default limits ($25 a transfer, $50 a click), and these balances. */
  async function setup(balances: Record<string, bigint>) {
    const settings = new SettingsStore(new MemoryStore());
    const svc = new SolanaService({
      vault: { listAccounts: async () => accounts } as never,
      settings,
      local: new MemoryStore(),
      history: { list: async () => [] },
      notify: () => undefined,
      now: Date.now,
    });
    const info = (lamports: bigint): AccountInfo => ({
      owner: SYSTEM_PROGRAM,
      lamports,
      data: new Uint8Array(0),
      executable: false,
    });
    let rentReads = 0;
    // Reads only: nothing is signed or sent (the blockhash never comes).
    svc.rpcFor = () =>
      ({
        getMultipleAccounts: async (addrs: string[]) =>
          addrs.map((a) => {
            const lamports = balances[a];
            return lamports !== undefined ? info(lamports) : null;
          }),
        minimumBalance: async (size: number) => {
          rentReads++;
          return BigInt(128 + size) * 5_080n;
        },
        getLatestBlockhash: () => Promise.reject(new Error('offline')),
      }) as never;
    Object.assign(svc, { price: { usd: async () => 150 } });
    return { svc, fee: networkFee(await settings.getSolana()), rentReads: () => rentReads };
  }
  const statuses = (t: { legs: { walletName: string; status: string; error?: string }[] }) =>
    t.legs.map((l) => [l.walletName, l.status, l.error ?? null]);

  it('sends to each wallet, skipping new ones that would get too little to exist', async () => {
    const { svc, rentReads } = await setup({ [WALLET]: SOL, [W1]: 10_000_000n });
    const t = await svc.transfers.distribute({
      hubId: 'hub',
      walletIds: ['hub', 'w1', 'w2'],
      amountEach: '0.0005',
    });
    expect(t.kind).toBe('distribute');
    expect(statuses(t)).toEqual([
      ['hub → w1', 'queued', null],
      ['hub → w2', 'skipped', 'A new wallet needs at least 0.00065024 SOL'],
    ]);
    expect(t.legs[0]?.amountIn).toBe('500000');
    await expect(
      svc.transfers.distribute({ hubId: 'hub', walletIds: ['w2'], amountEach: '0.0005' }),
    ).rejects.toMatchObject({ detail: 'A new wallet needs at least 0.00065024 SOL to exist.' });
    // Read from the chain once, then reused.
    expect(rentReads()).toBe(1);
  });

  it('keeps the sending wallet empty or able to exist, whatever order the transfers land in', async () => {
    const { fee } = await setup({});
    const each = SOL / 10n;
    const need = 2n * (each + fee);
    const two = async (hub: bigint) =>
      (await setup({ [WALLET]: hub, [W1]: SOL })).svc.transfers.distribute({
        hubId: 'hub',
        walletIds: ['w1', 'w2'],
        amountEach: '0.1',
      });
    // Exactly enough: the hub ends empty, having held at least the amount until the last.
    expect(statuses(await two(need))).toEqual([
      ['hub → w1', 'queued', null],
      ['hub → w2', 'queued', null],
    ]);
    await expect(two(need - 1n)).rejects.toMatchObject({
      detail: `About ${sol(need)} SOL is needed, fees included.`,
    });
    await expect(two(need + MIN - 1n)).rejects.toMatchObject({
      detail: 'Leave at least 0.00065024 SOL in hub: Solana closes a wallet below that.',
    });
    expect((await two(need + MIN)).legs.map((l) => l.status)).toEqual(['queued', 'queued']);

    // Emptied by an amount the fee would already leave it below: refused.
    const { svc } = await setup({ [WALLET]: 500_000n + fee, [W1]: SOL });
    await expect(
      svc.transfers.distribute({ hubId: 'hub', walletIds: ['w1'], amountEach: '0.0005' }),
    ).rejects.toMatchObject({
      detail: expect.stringMatching(/^Leave at least 0.00065024 SOL in hub/),
    });
  });

  it('holds to the USD limits and to SOL decimals', async () => {
    const { svc } = await setup({ [WALLET]: 10n * SOL, [W1]: SOL, [W2]: SOL, [W3]: SOL });
    const go = (amountEach: string, walletIds = ['w1', 'w2', 'w3']) =>
      svc.transfers.distribute({ hubId: 'hub', walletIds, amountEach });
    // $30 a transfer, above $25.
    await expect(go('0.2', ['w1'])).rejects.toMatchObject({
      detail: 'Per-transfer amount above your limit.',
    });
    // $18 each, $54 for the three: above $50.
    await expect(go('0.12')).rejects.toMatchObject({ detail: 'Total above your per-click limit.' });
    await expect(go('0.0000000001')).rejects.toMatchObject({
      detail: 'SOL has at most 9 decimals.',
    });
    await expect(
      svc.transfers.distribute({ hubId: 'evm', walletIds: ['w1'], amountEach: '0.1' }),
    ).rejects.toMatchObject({ detail: 'That wallet has no Solana address.' });
    expect((await go('0.1')).legs.map((l) => l.status)).toEqual(['queued', 'queued', 'queued']);
  });

  it('collects all of each wallet, skipping empty ones and ones too small to empty', async () => {
    const { svc, fee } = await setup({ [WALLET]: SOL, [W1]: 10_000_000n, [W3]: 1_000_000n });
    const t = await svc.transfers.collect({ hubId: 'hub', walletIds: ['w1', 'w2', 'w3', 'evm'] });
    expect(t.kind).toBe('collect');
    expect(statuses(t)).toEqual([
      ['w1 → hub', 'queued', null],
      ['w2 → hub', 'skipped', 'Nothing to collect'],
      [
        'w3 → hub',
        'skipped',
        `Too little to empty this wallet: that takes at least ${sol(MIN + fee)} SOL.`,
      ],
    ]);
    expect(t.legs[0]?.amountIn).toBe((10_000_000n - fee).toString());
    expect(t.legs[0]?.walletId).toBe('w1');
  });
});
