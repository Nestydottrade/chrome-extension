import { encodeFunctionData, parseAbi, parseEther, parseGwei, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { erc20Abi } from '../src/background/chain/abis';
import { buildCreateTx, mineFlapSalt } from '../src/background/create/evm';
import { SettingsStore } from '../src/background/settings';
import { act } from '../src/background/trade/actions';
import type { FeeCache } from '../src/background/trade/fees';
import type { PriceService } from '../src/background/trade/prices';
import { Routing } from '../src/background/trade/routing';
import type { EvmTx, TxPurpose } from '../src/background/trade/signer';
import { SiteEvmChecker, type SiteEvmCheck } from '../src/background/trade/site-evm';
import type { PoolRef, Venue } from '../src/background/trade/types';
import { PERMIT2, UNISWAP } from '../src/background/trade/uniswap/addresses';
import type { ExtraContractRule } from '../src/background/trade/validator';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { WireCreateSpec } from '../src/shared/site-bridge';
import type { EvmAccount } from '../src/shared/wallet';

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
const ME = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;
const OTHER: Address = '0x000000000000000000000000000000000000dEaD';
const TOKEN: Address = '0x00000000000000000000000000000000000070c0';
const CURVE: Address = '0x000000000000000000000000000000000000c0de';
const BASE = 8453;
const UR = UNISWAP[BASE]!.universalRouter;
const wallet: EvmAccount = {
  id: 'w1',
  name: 'Main',
  hidden: false,
  primary: true,
  kind: 'derived',
  address: ME,
};

const curveAbi = parseAbi([
  'function buy(uint256 amountIn, uint256 minOut, address to) payable',
  'function sell(uint256 amountIn, uint256 minOut, address to)',
]);

/** A curve quoting 1 000 tokens per wei in, its own contract the sell spender. */
function curve(id = 'curve', extra: Partial<Venue> = {}): Venue {
  return {
    id,
    supports: () => true,
    discover: async (_c, token) => [
      { venueId: id, id: `${id}:${token.toLowerCase()}`, label: 'Test curve', token, data: null },
    ],
    quote: async (_c, _p, side, amounts) =>
      amounts.map((a) => (side === 'buy' ? a * 1000n : a / 1000n)),
    buildBuy: (_c, _p, p) => ({
      to: CURVE,
      data: encodeFunctionData({
        abi: curveAbi,
        functionName: 'buy',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: p.amountIn,
    }),
    buildSell: (_c, _p, p) => ({
      to: CURVE,
      data: encodeFunctionData({
        abi: curveAbi,
        functionName: 'sell',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: 0n,
    }),
    sellApproval: () => ({ spender: CURVE, viaPermit2: false, router: CURVE }),
    ...extra,
  };
}

const rule: ExtraContractRule = {
  label: 'Test curve',
  approvalSpender: true,
  validate: () => [act('Curve trade')],
};

const ref = (venueId = 'curve') => ({
  token: TOKEN,
  venueId,
  poolId: `${venueId}:${TOKEN.toLowerCase()}`,
});

const now = 1_000_000_000;
let balance = 0n;
let settings: SettingsStore;
let checker: SiteEvmChecker;

beforeEach(() => {
  balance = 0n;
  settings = new SettingsStore(new MemoryStore());
  const client = {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'balanceOf' ? balance : 'TEST',
  };
  checker = new SiteEvmChecker({
    settings,
    client: () => client as never,
    routing: new Routing([curve(), curve('agg', { prepare: async () => ({}) as never })]),
    prices: { nativeUsd: async () => 2000 } as unknown as PriceService,
    fees: { baseFee: async () => parseGwei('1') } as unknown as FeeCache,
    extraContracts: () => new Map([[CURVE.toLowerCase(), rule]]),
    now: () => now,
  });
});

/** The transaction Nesty's own flow would send for this buy, and its purpose. */
function buy(amountIn = parseEther('0.005'), minOut = amountIn * 900n, venueId = 'curve') {
  const purpose: TxPurpose = {
    kind: 'swap',
    ref: ref(venueId),
    side: 'buy',
    amountIn,
    minOut,
    deadline: 2_000_000n,
  };
  const built = curve().buildBuy({} as never, {} as PoolRef, {
    wallet: ME,
    amountIn,
    minOut,
    deadline: 2_000_000n,
  });
  return { purpose, tx: tx(built) };
}

function tx(draft: Pick<EvmTx, 'to' | 'data' | 'value'>, extra: Partial<EvmTx> = {}): EvmTx {
  return {
    chainId: BASE,
    nonce: 3,
    gas: 300_000n,
    maxFeePerGas: parseGwei('2'),
    maxPriorityFeePerGas: parseGwei('0.1'),
    ...draft,
    ...extra,
  };
}

const reason = (c: SiteEvmCheck) => (c.ok ? null : c.reason);

describe('EVM transactions the Nesty website asks to sign', () => {
  it('signs a buy built exactly as its purpose says, at its USD value', async () => {
    const { tx, purpose } = buy();
    const check = await checker.checkTx(wallet, [ME], tx, purpose);
    expect(check).toMatchObject({ ok: true, usd: 10 });
    expect(check.ok && check.summary).toContain('Buy TEST for about 0.005 ETH on Test curve');
  });

  it('refuses a transaction that is not what its purpose says', async () => {
    const { purpose } = buy();
    // The same buy paying out to someone else.
    const theirs = curve().buildBuy({} as never, {} as PoolRef, {
      wallet: OTHER,
      amountIn: parseEther('0.005'),
      minOut: parseEther('0.005') * 900n,
      deadline: 2_000_000n,
    });
    expect(reason(await checker.checkTx(wallet, [ME], tx(theirs), purpose))).toMatch(
      /not the trade it says/,
    );
    // Or carrying more value than it says it spends.
    const { tx: t } = buy();
    expect(
      reason(await checker.checkTx(wallet, [ME], { ...t, value: parseEther('0.006') }, purpose)),
    ).toMatch(/not the trade it says/);
  });

  it('refuses a minimum received under half of what the pool pays now', async () => {
    const amount = parseEther('0.005');
    const { tx, purpose } = buy(amount, amount * 499n);
    expect(reason(await checker.checkTx(wallet, [ME], tx, purpose))).toMatch(/under half/);
  });

  it("holds buys to the user's per-transaction limit and gas limit", async () => {
    const big = buy(parseEther('0.02')); // $40 against $25
    expect(reason(await checker.checkTx(wallet, [ME], big.tx, big.purpose))).toMatch(
      /per-transaction limit/,
    );
    const { tx: t, purpose } = buy();
    // A 100 gwei tip: about $50 of gas against a $10 limit.
    const pricey = { ...t, maxFeePerGas: parseGwei('200'), maxPriorityFeePerGas: parseGwei('100') };
    expect(reason(await checker.checkTx(wallet, [ME], pricey, purpose))).toMatch(/gas limit/);
  });

  it('finds the pool on the chain, and never signs an aggregator route', async () => {
    const { tx, purpose } = buy();
    const elsewhere = { ...purpose, ref: { ...ref(), poolId: 'curve:0xsomewhere' } };
    expect(reason(await checker.checkTx(wallet, [ME], tx, elsewhere))).toMatch(
      /could not find this pool/,
    );
    const agg = buy(undefined, undefined, 'agg');
    expect(reason(await checker.checkTx(wallet, [ME], agg.tx, agg.purpose))).toMatch(/aggregator/);
  });

  it("approves only the pool's own spenders, within the bound when bounded", async () => {
    const approve = (spender: Address, amount: bigint) => ({
      purpose: { kind: 'approve', ref: ref(), asset: TOKEN, spender, amount } as TxPurpose,
      tx: tx({
        to: TOKEN,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, amount],
        }),
        value: 0n,
      }),
    });
    const max = 2n ** 256n - 1n;
    const ok = approve(CURVE, max);
    expect((await checker.checkTx(wallet, [ME], ok.tx, ok.purpose)).ok).toBe(true);
    const stranger = approve(OTHER, max);
    expect(reason(await checker.checkTx(wallet, [ME], stranger.tx, stranger.purpose))).toMatch(
      /does not approve this spender/,
    );
    // Not a funded pool: Permit2 is no spender of its sells.
    const permit2 = approve(PERMIT2, max);
    expect((await checker.checkTx(wallet, [ME], permit2.tx, permit2.purpose)).ok).toBe(false);

    await settings.update({ unlimitedApprovals: false, approvalBufferBps: 1_000 });
    balance = 1_000n;
    // A buy just signed brings 5e18 more: the bound covers it.
    const b = buy();
    const bought = await checker.checkTx(wallet, [ME], b.tx, b.purpose);
    checker.noteSigned(wallet, b.tx, b.purpose, bought);
    const covered = approve(CURVE, ((1_000n + parseEther('5')) * 11n) / 10n);
    expect((await checker.checkTx(wallet, [ME], covered.tx, covered.purpose)).ok).toBe(true);
    const unlimited = approve(CURVE, max);
    const refused = await checker.checkTx(wallet, [ME], unlimited.tx, unlimited.purpose);
    expect(reason(refused)).toMatch(/bounded amount/);
    // The website lists what Nesty decoded, the refused action among them.
    expect(refused.ok ? null : refused.actions?.find((a) => !a.ok)?.reason).toMatch(
      /bounded amount/,
    );
  });

  it('cancels and speeds up only what it signed', async () => {
    const empty = (to: Address) => tx({ to, data: '0x', value: 0n });
    expect((await checker.checkTx(wallet, [ME], empty(ME), { kind: 'empty' })).ok).toBe(true);
    expect((await checker.checkTx(wallet, [ME], empty(OTHER), { kind: 'empty' })).ok).toBe(false);

    const { tx: t, purpose } = buy();
    const faster = { ...t, maxPriorityFeePerGas: parseGwei('0.2') };
    expect(reason(await checker.checkTx(wallet, [ME], faster, { kind: 'replace' }))).toMatch(
      /no longer has this transaction/,
    );
    checker.noteSigned(wallet, t, purpose, await checker.checkTx(wallet, [ME], t, purpose));
    expect((await checker.checkTx(wallet, [ME], faster, { kind: 'replace' })).ok).toBe(true);
    const changed = { ...faster, value: parseEther('0.004') };
    expect(reason(await checker.checkTx(wallet, [ME], changed, { kind: 'replace' }))).toMatch(
      /same transaction/,
    );
  });

  it('lets a Permit2 sell take no more than the wallet holds', async () => {
    const viaPermit2 = new SiteEvmChecker({
      settings,
      client: () =>
        ({
          readContract: async ({ functionName }: { functionName: string }) =>
            functionName === 'balanceOf' ? 500n : 'TEST',
        }) as never,
      routing: new Routing([
        curve('v3', { sellApproval: () => ({ spender: PERMIT2, viaPermit2: true, router: UR }) }),
      ]),
      prices: { nativeUsd: async () => 2000 } as unknown as PriceService,
      fees: { baseFee: async () => parseGwei('1') } as unknown as FeeCache,
      extraContracts: () => new Map(),
      now: () => now,
    });
    const permit = (amount: bigint) => ({
      kind: 'permit' as const,
      ref: ref('v3'),
      permit: {
        details: { token: TOKEN, amount, expiration: now / 1000 + 600, nonce: 0 },
        spender: UR,
        sigDeadline: BigInt(now / 1000 + 600),
      },
    });
    expect((await viaPermit2.checkPermit(wallet, [ME], BASE, permit(500n))).ok).toBe(true);
    expect((await viaPermit2.checkPermit(wallet, [ME], BASE, permit(501n))).ok).toBe(false);
  });
});

describe('new coins the Nesty website asks to create', () => {
  const PONS_FEE = parseEther('0.0005');
  const IMAGE = 'ipfs://bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva';
  const SALT = `0x${'00'.repeat(31)}01` as const;
  let creator: SiteEvmChecker;

  beforeEach(() => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'launchFee' ? PONS_FEE : 'TEST',
    };
    creator = new SiteEvmChecker({
      settings: new SettingsStore(new MemoryStore()),
      client: () => client as never,
      routing: new Routing([]),
      prices: { nativeUsd: async () => 2000 } as unknown as PriceService,
      fees: { baseFee: async () => parseGwei('1') } as unknown as FeeCache,
      extraContracts: () => new Map(),
      now: () => now,
    });
  });

  const clanker = (devBuy = parseEther('0.001')): WireCreateSpec => ({
    launchpad: 'clanker',
    name: 'Nesty Test',
    symbol: 'CTEST',
    image: IMAGE,
    metadata: JSON.stringify({ description: 'A test', socialMediaUrls: [] }),
    salt: SALT,
    devBuy: devBuy.toString(),
  });
  const create = (spec: WireCreateSpec, chainId = BASE, extra: Partial<EvmTx> = {}) =>
    creator.checkTx(
      wallet,
      [ME],
      tx(buildCreateTx(chainId, ME, spec), { chainId, gas: 5_000_000n, ...extra }),
      {
        kind: 'create',
        spec,
      },
    );

  it('signs a coin built exactly from its spec, at its dev buy in USD', async () => {
    const check = await create(clanker());
    expect(check).toMatchObject({ ok: true, usd: 2 });
    expect(check.ok && check.summary).toBe('Create CTEST on Clanker and buy it for 0.001 ETH');
    expect(await create(clanker(0n))).toMatchObject({
      ok: true,
      summary: 'Create CTEST on Clanker',
    });
  });

  it('refuses a coin that is not what its spec says', async () => {
    const spec = clanker();
    // The same coin, its rewards and dev buy going to someone else.
    const theirs = tx(buildCreateTx(BASE, OTHER, spec), { gas: 5_000_000n });
    expect(reason(await creator.checkTx(wallet, [ME], theirs, { kind: 'create', spec }))).toMatch(
      /not the coin it says/,
    );
    // Or on a launchpad that does not create coins on this chain.
    const klik: WireCreateSpec = {
      launchpad: 'klik',
      name: 'Nesty Test',
      symbol: 'CTEST',
      metadata: IMAGE,
      salt: SALT,
      devBuy: '0',
    };
    expect(reason(await create(klik, 1, { chainId: BASE }))).toMatch(
      /Klik does not create coins here/,
    );
    // Or with a name the launchpad would not show.
    expect(reason(await create({ ...spec, name: 'Nesty\u202eTest' }))).toMatch(/hidden characters/);
  });

  it("holds the dev buy to the user's per-transaction limit and the gas to the gas limit", async () => {
    // $25 a transaction by default: 0.0125 ETH at $2,000.
    expect(reason(await create(clanker(parseEther('0.02'))))).toMatch(/per-transaction limit/);
    // A coin's gas is counted in full: about $13.50 here, over the $10 default.
    expect(reason(await create(clanker(), BASE, { gas: 8_000_000n }))).toMatch(/gas limit/);
  });

  it("takes only a Flap salt that gives Flap's address", async () => {
    const flap = (salt: string): WireCreateSpec => ({
      launchpad: 'flap',
      name: 'Nesty Test',
      symbol: 'CTEST',
      meta: 'bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva',
      taxBps: 100,
      salt,
      devBuy: '0',
    });
    expect((await create(flap(await mineFlapSalt(BASE, 100)))).ok).toBe(true);
    expect(reason(await create(flap(SALT)))).toMatch(/address Flap requires/);
  });

  it('pays Pons its launch fee, exactly', async () => {
    const pons = (fee: bigint): WireCreateSpec => ({
      launchpad: 'pons',
      name: 'Nesty Test',
      symbol: 'CTEST',
      logo: IMAGE,
      description: 'A test',
      links: { twitter: '', telegram: '', website: '' },
      creatorTaxBps: 100,
      salt: SALT,
      fee: fee.toString(),
    });
    const check = await create(pons(PONS_FEE), 4663);
    expect(check.ok && check.summary).toBe('Create CTEST on Pons for its 0.0005 ETH launch fee');
    expect(reason(await create(pons(PONS_FEE * 2n), 4663))).toMatch(/not the Pons launch fee/);
  });
});
