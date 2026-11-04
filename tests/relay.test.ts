import { bytesToHex, encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKEN_PROGRAM } from '../src/background/solana/address';
import { publicKeyOf } from '../src/background/solana/keys';
import { relayDepositNative } from '../src/background/solana/relay';
import { setComputeUnitLimit } from '../src/background/solana/spl';
import type { Instruction } from '../src/background/solana/tx';
import {
  BRIDGE_SLIPPAGE_BPS,
  RELAY_DEPOSITORY,
  RelayError,
  SOLANA_NATIVE,
  checkQuote,
  checkSolanaQuote,
  createRelayClient,
  relayRule,
  type RelayQuote,
} from '../src/background/trade/relay';
import { validateTx } from '../src/background/trade/validator';
import { getChain } from '../src/shared/chains';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

const ME: Address = '0x1111111111111111111111111111111111111111';
const MY_OTHER: Address = '0x2222222222222222222222222222222222222222';
const ATTACKER: Address = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** The deposit's id, and Relay's id for the request: two different things. */
const ID: Hex = `0x${'ab'.repeat(32)}`;
const REQUEST_ID: Hex = `0x${'17'.repeat(32)}`;
const STATUS = `/intents/status?requestId=${REQUEST_ID}`;
const AMOUNT = parseEther('0.05');
const abi = parseAbi(['function depositNative(address depositor, bytes32 id) payable']);

/** Made-up Solana wallets: base58, so their case matters. */
const SOL_ME = publicKeyOf(new Uint8Array(32).fill(7));
const SOL_OTHER = publicKeyOf(new Uint8Array(32).fill(8));
const LAMPORTS = 100_000_000n;
const DEPOSIT_ID = new Uint8Array(32).fill(0xbb);
const hex = (b: Uint8Array) => bytesToHex(b).slice(2);

interface Over {
  recipient?: string;
  extraStep?: boolean;
  minOut?: string;
  /** Where and in what the payout is. */
  outChainId?: number;
  outCurrency?: string;
  /** The status check and the step's request id (null: left out). */
  check?: string | null;
  stepRequestId?: string | null;
}

/** A quote as Relay returns it, around one step item's transaction data. */
function relayQuote(
  data: unknown,
  over: Over,
  out: { amount: string; minimumAmount: string },
): RelayQuote {
  const step = {
    id: 'deposit',
    kind: 'transaction',
    ...(over.stepRequestId === null ? {} : { requestId: over.stepRequestId ?? REQUEST_ID }),
    items: [
      {
        data,
        ...(over.check === null
          ? {}
          : { check: { endpoint: over.check ?? STATUS, method: 'GET' } }),
      },
    ],
  };
  return {
    steps: over.extraStep ? [step, step] : [step],
    fees: { gas: { amountUsd: '0.01' }, relayer: { amountUsd: '0.09' } },
    details: {
      recipient: over.recipient ?? MY_OTHER,
      timeEstimate: 2,
      currencyOut: {
        currency: { chainId: over.outChainId ?? 56, address: over.outCurrency ?? NATIVE },
        amount: out.amount,
        minimumAmount: over.minOut ?? out.minimumAmount,
      },
    },
    // As parsed: the data is whatever each test gives, checked or not.
  } as RelayQuote;
}

function quote(
  over: Over & { to?: string; depositor?: Address; value?: bigint; chainId?: number } = {},
) {
  const data = encodeFunctionData({
    abi,
    functionName: 'depositNative',
    args: [over.depositor ?? ME, ID],
  });
  return relayQuote(
    {
      to: over.to ?? RELAY_DEPOSITORY,
      data,
      value: String(over.value ?? AMOUNT),
      chainId: over.chainId ?? 8453,
    },
    over,
    // 0.5% below the amount, as Relay quotes it for BRIDGE_SLIPPAGE_BPS.
    { amount: '155700000000000000', minimumAmount: '154921500000000000' },
  );
}

const params = {
  user: ME,
  recipient: MY_OTHER as string,
  fromChainId: 8453,
  toChainId: 56,
  amount: AMOUNT,
};

describe('Relay quote checks', () => {
  it('accepts a single deposit for the requested amount and recipient', () => {
    const q = checkQuote(quote(), params);
    expect(q.tx).toMatchObject({ to: RELAY_DEPOSITORY, value: AMOUNT });
    expect(q.amountOut).toBe(155_700_000_000_000_000n);
    expect(q.minOut).toBe(154_921_500_000_000_000n);
    expect(q.feeUsd).toBeCloseTo(0.1);
    // Followed by Relay's request id, not by the deposit's.
    expect(q.requestId).toBe(REQUEST_ID);
    expect(q.statusPath).toBe(STATUS);
  });

  it('finds the request from the step when there is no status check', () => {
    const q = checkQuote(quote({ check: null }), params);
    expect(q.statusPath).toBe(STATUS);
    expect(() => checkQuote(quote({ check: null, stepRequestId: null }), params)).toThrow(
      /no request id/,
    );
  });

  it.each([
    ['unknown contract', { to: ATTACKER }, /unknown contract/],
    ['deposit credited to someone else', { depositor: ATTACKER }, /not credited/],
    ['different value', { value: AMOUNT * 2n }, /value differs/],
    ['other chain', { chainId: 1 }, /different chain/],
    ['swapped recipient', { recipient: ATTACKER }, /recipient differs/],
    ['extra steps', { extraStep: true }, /unexpected steps/],
    // Relay's own default between Robinhood and BSC: 2%.
    ['a looser minimum than asked', { minOut: '152586000000000000' }, /more slippage/],
    ['no minimum', { minOut: '0' }, /more slippage/],
    ['a payout on another chain', { outChainId: 1 }, /pays out on a different chain/],
    ['a token payout', { outCurrency: USDC_BASE }, /not the native coin/],
    ['two request ids', { stepRequestId: `0x${'18'.repeat(32)}` }, /two requests/],
    ['an unexpected status path', { check: `/requests/${REQUEST_ID}` }, /status path/],
  ] as const)('rejects %s', (_name, over, msg) => {
    expect(() => checkQuote(quote(over), params)).toThrow(RelayError);
    expect(() => checkQuote(quote(over), params)).toThrow(msg);
  });

  it('rejects calldata that is not depositNative', () => {
    const q = quote();
    (q.steps[0]!.items[0]!.data as { data: string }).data = '0xa9059cbb' + '00'.repeat(64);
    expect(() => checkQuote(q, params)).toThrow(/not a native deposit/);
  });

  it('pays a Solana wallet in SOL, its base58 address matched exactly', () => {
    const toSol = { outChainId: SOLANA_CHAIN_ID, outCurrency: SOLANA_NATIVE, recipient: SOL_ME };
    const p = { ...params, toChainId: SOLANA_CHAIN_ID, recipient: SOL_ME };
    expect(checkQuote(quote(toSol), p).requestId).toBe(REQUEST_ID);
    expect(() => checkQuote(quote({ ...toSol, recipient: SOL_ME.toLowerCase() }), p)).toThrow(
      /recipient differs/,
    );
    expect(() => checkQuote(quote({ ...toSol, recipient: SOL_OTHER }), p)).toThrow(
      /recipient differs/,
    );
    expect(() => checkQuote(quote({ ...toSol, outCurrency: NATIVE }), p)).toThrow(
      /not the native coin/,
    );
  });
});

describe('Relay quotes from Solana', () => {
  const solParams = { user: SOL_ME, recipient: MY_OTHER, toChainId: 8453, amount: LAMPORTS };
  /** Relay's JSON for an instruction: data in hex, without 0x. */
  const json = (ix: Instruction) => ({ ...ix, data: hex(ix.data) });

  function solQuote(
    over: Over & {
      deposit?: Partial<ReturnType<typeof json>>;
      amount?: bigint;
      before?: readonly Instruction[];
      evm?: boolean;
    } = {},
  ) {
    const deposit = {
      ...json(relayDepositNative(SOL_ME, over.amount ?? LAMPORTS, DEPOSIT_ID)),
      ...over.deposit,
    };
    return relayQuote(
      over.evm
        ? { to: RELAY_DEPOSITORY, data: '0x', value: '0', chainId: SOLANA_CHAIN_ID }
        : {
            instructions: [...(over.before ?? []).map(json), deposit],
            addressLookupTableAddresses: [SOL_OTHER],
          },
      { outChainId: 8453, ...over },
      // As Relay quoted 0.1 SOL to Base, 0.5% slippage.
      { amount: '4258391295470733', minimumAmount: '4237099338993379' },
    );
  }

  it('builds deposit_native exactly as Relay quotes it', () => {
    const ix = relayDepositNative(SOL_ME, LAMPORTS, DEPOSIT_ID);
    // Program, accounts and data layout of a live quote; only the wallet is made up.
    expect(ix.programId).toBe('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2');
    expect(ix.keys).toEqual([
      {
        pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc',
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SOL_ME, isSigner: true, isWritable: true },
      { pubkey: SOL_ME, isSigner: false, isWritable: false },
      { pubkey: '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ', isSigner: false, isWritable: true },
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
    ]);
    expect(hex(ix.data)).toBe(`0d9e0ddf5fd51c06${'00e1f50500000000'}${'bb'.repeat(32)}`);
  });

  it('accepts one deposit of the amount, from and credited to the wallet', () => {
    const q = checkSolanaQuote(solQuote(), solParams);
    expect(q.depositId).toEqual(DEPOSIT_ID);
    expect(q.amountIn).toBe(LAMPORTS);
    expect(q.amountOut).toBe(4_258_391_295_470_733n);
    expect(q.minOut).toBe(4_237_099_338_993_379n);
    expect(q.requestId).toBe(REQUEST_ID);
    expect(q.statusPath).toBe(STATUS);
    // Compute budget is Nesty's own to set: any in the quote is left out, not refused.
    expect(() =>
      checkSolanaQuote(solQuote({ before: [setComputeUnitLimit(50_000)] }), solParams),
    ).not.toThrow();
  });

  it.each([
    ['another program', { deposit: { programId: TOKEN_PROGRAM } }, /unknown program/],
    [
      'an extra instruction',
      { before: [relayDepositNative(SOL_ME, 1n, DEPOSIT_ID)] },
      /single deposit/,
    ],
    ['a different amount', { amount: LAMPORTS + 1n }, /value differs/],
    [
      'other instruction data',
      { deposit: { data: `f8c69e91e17587c8${'00'.repeat(40)}` } },
      /not a native deposit/,
    ],
    ['data that is not hex', { deposit: { data: 'not hex' } }, /not a native deposit/],
    ['EVM transaction data', { evm: true }, /different chain/],
    ['a swapped recipient', { recipient: ATTACKER }, /recipient differs/],
    ['a looser minimum than asked', { minOut: '4200000000000000' }, /more slippage/],
    ['a payout on another chain', { outChainId: 56 }, /pays out on a different chain/],
  ] as const)('rejects %s', (_name, over, msg) => {
    expect(() => checkSolanaQuote(solQuote(over), solParams)).toThrow(RelayError);
    expect(() => checkSolanaQuote(solQuote(over), solParams)).toThrow(msg);
  });

  it('rejects a deposit sent or credited by another wallet', () => {
    const keys = relayDepositNative(SOL_ME, LAMPORTS, DEPOSIT_ID).keys;
    const swap = (i: number) => keys.map((k, j) => (j === i ? { ...k, pubkey: SOL_OTHER } : k));
    expect(() => checkSolanaQuote(solQuote({ deposit: { keys: swap(2) } }), solParams)).toThrow(
      /not credited/,
    );
    expect(() => checkSolanaQuote(solQuote({ deposit: { keys: swap(1) } }), solParams)).toThrow(
      /unexpected accounts/,
    );
    expect(() => checkSolanaQuote(solQuote({ deposit: { keys: swap(3) } }), solParams)).toThrow(
      /unexpected accounts/,
    );
  });
});

describe('Relay client', () => {
  function client(response: unknown) {
    const sent: Record<string, unknown>[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    return { relay: createRelayClient(fetchFn), sent };
  }

  it('asks for the bridge slippage instead of leaving it to Relay', async () => {
    const { relay, sent } = client(quote());
    const q = await relay.quote(params);
    expect(sent[0]).toMatchObject({
      slippageTolerance: String(BRIDGE_SLIPPAGE_BPS),
      originCurrency: NATIVE,
      destinationCurrency: NATIVE,
    });
    expect(q.minOut).toBe(154_921_500_000_000_000n);
  });

  it('asks for SOL on Solana by its own address, both ways', async () => {
    const toSol = client(
      quote({ outChainId: SOLANA_CHAIN_ID, outCurrency: SOLANA_NATIVE, recipient: SOL_ME }),
    );
    await toSol.relay.quote({ ...params, toChainId: SOLANA_CHAIN_ID, recipient: SOL_ME });
    expect(toSol.sent[0]).toMatchObject({
      destinationChainId: SOLANA_CHAIN_ID,
      destinationCurrency: SOLANA_NATIVE,
      recipient: SOL_ME,
    });

    const json = relayDepositNative(SOL_ME, LAMPORTS, DEPOSIT_ID);
    const fromSol = client(
      relayQuote(
        { instructions: [{ ...json, data: hex(json.data) }] },
        { outChainId: 8453 },
        { amount: '4258391295470733', minimumAmount: '4237099338993379' },
      ),
    );
    const q = await fromSol.relay.quoteFromSolana({
      user: SOL_ME,
      recipient: MY_OTHER,
      toChainId: 8453,
      amount: LAMPORTS,
    });
    expect(fromSol.sent[0]).toMatchObject({
      user: SOL_ME,
      originChainId: SOLANA_CHAIN_ID,
      originCurrency: SOLANA_NATIVE,
      destinationCurrency: NATIVE,
      amount: LAMPORTS.toString(),
      slippageTolerance: String(BRIDGE_SLIPPAGE_BPS),
    });
    expect(q.depositId).toEqual(DEPOSIT_ID);
  });

  it("reads the payout in the destination chain's own format", async () => {
    const SIG = '5'.repeat(87);
    const HASH = `0x${'cd'.repeat(32)}`;
    const { relay } = client({ status: 'success', txHashes: [HASH, SIG] });
    expect(await relay.status(STATUS, SOLANA_CHAIN_ID)).toEqual({
      status: 'success',
      outHash: SIG,
    });
    expect(await relay.status(STATUS, 8453)).toEqual({ status: 'success', outHash: HASH });
    expect(
      await client({ status: 'pending', txHashes: [HASH] }).relay.status(STATUS, SOLANA_CHAIN_ID),
    ).toEqual({
      status: 'pending',
    });
    await expect(relay.status('/elsewhere', 8453)).rejects.toThrow(/status path/);
  });
});

describe('Relay validator rule', () => {
  const chain = getChain(8453)!;
  const ctx = {
    chain,
    from: ME,
    ownWallets: [ME, MY_OTHER],
    extraContracts: new Map([[RELAY_DEPOSITORY.toLowerCase(), relayRule]]),
    maxValue: parseEther('0.1'),
    nowS: 1_800_000_000,
  };
  const deposit = (depositor: Address, value = AMOUNT) => ({
    to: RELAY_DEPOSITORY,
    data: encodeFunctionData({ abi, functionName: 'depositNative', args: [depositor, ID] }),
    value,
  });

  it('allows a deposit credited to the sender', () => {
    expect(validateTx(deposit(ME), ctx).ok).toBe(true);
  });

  it('blocks deposits credited to another address, even another own wallet', () => {
    expect(validateTx(deposit(ATTACKER), ctx).ok).toBe(false);
    expect(validateTx(deposit(MY_OTHER), ctx).ok).toBe(false);
  });

  it('applies the per-transaction limit', () => {
    expect(validateTx(deposit(ME, parseEther('1')), ctx).ok).toBe(false);
  });
});
