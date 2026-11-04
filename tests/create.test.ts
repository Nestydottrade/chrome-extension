import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseEther,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  buildCreateTx,
  clankerAbi,
  createdToken,
  createValue,
  flapAbi,
  flapSaltOk,
  flapTokenAddress,
  KLIK_CONFIG,
  KLIK_FACTORY,
  KLIK_PROFILE,
  klikAbi,
  mineFlapSalt,
  PONS_LAUNCH_FACTORY,
  ponsLaunchAbi,
} from '../src/background/create/evm';
import {
  createIntentProblem,
  createSpecProblem,
  flapTaxes,
  launchpadsOn,
  linkProblem,
  textProblem,
} from '../src/shared/create';
import type { SolCreateIntent, WireCreateSpec } from '../src/shared/site-bridge';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

// A throwaway key made up for the test: never a real wallet's.
const ME = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;
const OTHER: Address = '0x000000000000000000000000000000000000dEaD';
const TOKEN = getAddress('0x00000000000000000000000000000000000070c0');
const SALT: Hex = `0x${'00'.repeat(31)}01`;
const CID = 'bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva';
const IMAGE = `ipfs://${CID}`;

type Spec<L extends WireCreateSpec['launchpad']> = Extract<WireCreateSpec, { launchpad: L }>;

const flap = (taxBps: number, devBuy = 0n): Spec<'flap'> => ({
  launchpad: 'flap',
  name: 'Nesty Test',
  symbol: 'CTEST',
  meta: CID,
  taxBps,
  salt: SALT,
  devBuy: devBuy.toString(),
});
const clanker = (devBuy = 0n): Spec<'clanker'> => ({
  launchpad: 'clanker',
  name: 'Nesty Test',
  symbol: 'CTEST',
  image: IMAGE,
  metadata: JSON.stringify({ description: 'A test', socialMediaUrls: [], auditUrls: [] }),
  salt: SALT,
  devBuy: devBuy.toString(),
});
const klik = (devBuy = 0n): Spec<'klik'> => ({
  launchpad: 'klik',
  name: 'Nesty Test',
  symbol: 'CTEST',
  metadata: IMAGE,
  salt: SALT,
  devBuy: devBuy.toString(),
});
const pons = (fee = parseEther('0.0005')): Spec<'pons'> => ({
  launchpad: 'pons',
  name: 'Nesty Test',
  symbol: 'CTEST',
  logo: IMAGE,
  description: 'A test',
  links: { twitter: 'https://x.com/nesty', telegram: '', website: '' },
  creatorTaxBps: 100,
  salt: SALT,
  fee: fee.toString(),
});

/** A receipt's log, as much of it as reading an event needs. */
const log = (address: Address, topics: readonly (Hex | Hex[] | null)[], data: Hex = '0x') =>
  ({ address, topics, data }) as unknown as Log;

describe('creating a coin on an EVM launchpad', () => {
  it('calls each factory by the function its contract has on chain', () => {
    const selector = (chainId: number, spec: WireCreateSpec) =>
      buildCreateTx(chainId, ME, spec).data.slice(0, 10);
    expect(selector(56, flap(100))).toBe('0x8cb5772c'); // newTokenV6
    expect(selector(4663, flap(0))).toBe('0x2e2fdbd9'); // newTokenV5
    expect(selector(8453, clanker())).toBe('0xdf40224a'); // deployToken
    expect(selector(1, klik())).toBe('0x28962ef9'); // deployCoinWithHook
    expect(selector(4663, pons())).toBe('0xf35abbcf'); // launchToken
  });

  it("pays a Flap coin's tax to its creator, and Flap's interface commission to no one", () => {
    const tx = buildCreateTx(56, ME, flap(500, parseEther('0.01')));
    const { functionName, args } = decodeFunctionData({ abi: flapAbi, data: tx.data });
    expect(functionName).toBe('newTokenV6');
    expect(args[0]).toMatchObject({
      buyTaxRate: 500,
      sellTaxRate: 500,
      mktBps: 10_000,
      beneficiary: ME,
      commissionReceiver: zeroAddress,
      quoteToken: zeroAddress,
      quoteAmt: parseEther('0.01'),
      tokenVersion: 6,
    });
    expect(tx.value).toBe(parseEther('0.01'));
  });

  it('makes an untaxed Flap coin only where Flap still launches one', () => {
    expect(() => buildCreateTx(56, ME, flap(0))).toThrow(/Flap does not create this coin/);
    expect(() => buildCreateTx(8453, ME, flap(0))).toThrow(/Flap does not create this coin/);
    const { args } = decodeFunctionData({
      abi: flapAbi,
      data: buildCreateTx(4663, ME, flap(0)).data,
    });
    expect(args[0]).toMatchObject({ taxRate: 0, taxDuration: 0n, mktBps: 0, beneficiary: ME });
  });

  it("mines a salt that lands the coin on Flap's address", async () => {
    const salt = await mineFlapSalt(4663, 0);
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(flapSaltOk(4663, 0, salt)).toBe(true);
    expect(flapTokenAddress(4663, 0, salt).toLowerCase()).toMatch(/8888$/);
  });

  it("gives a Clanker coin's rewards to its creator, with the fees Nesty shows", () => {
    const tx = buildCreateTx(8453, ME, clanker());
    const cfg = decodeFunctionData({ abi: clankerAbi, data: tx.data }).args[0];
    expect(cfg.tokenConfig).toMatchObject({
      tokenAdmin: ME,
      name: 'Nesty Test',
      symbol: 'CTEST',
      image: IMAGE,
      originatingChainId: 8453n,
    });
    expect(cfg.lockerConfig).toMatchObject({
      rewardAdmins: [ME],
      rewardRecipients: [ME],
      rewardBps: [10_000],
      positionBps: [10_000],
    });
    expect(cfg.extensionConfigs).toEqual([]);
    expect(tx.value).toBe(0n);
    // 1% each way, and the sniper fee from 66.7% down to 4.2% over 15 seconds.
    const [pool] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'extension', type: 'address' },
            { name: 'extensionData', type: 'bytes' },
            { name: 'feeData', type: 'bytes' },
          ],
        },
      ],
      cfg.poolConfig.poolData,
    );
    expect(decodeAbiParameters([{ type: 'uint24' }, { type: 'uint24' }], pool.feeData)).toEqual([
      10_000, 10_000,
    ]);
    const [sniper] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'startingFee', type: 'uint24' },
            { name: 'endingFee', type: 'uint24' },
            { name: 'secondsToDecay', type: 'uint256' },
          ],
        },
      ],
      cfg.mevModuleConfig.mevModuleData,
    );
    expect(sniper).toEqual({ startingFee: 666_777, endingFee: 41_673, secondsToDecay: 15n });
  });

  it("sends a Clanker dev buy's coins to its creator", () => {
    const tx = buildCreateTx(1, ME, clanker(parseEther('0.01')));
    const cfg = decodeFunctionData({ abi: clankerAbi, data: tx.data }).args[0];
    expect(tx.value).toBe(parseEther('0.01'));
    expect(cfg.extensionConfigs).toHaveLength(1);
    expect(cfg.extensionConfigs[0]).toMatchObject({
      msgValue: parseEther('0.01'),
      extensionBps: 0,
    });
    // Its last word is the recipient.
    expect(cfg.extensionConfigs[0]!.extensionData.slice(-40)).toBe(ME.slice(2).toLowerCase());
  });

  it("opens a Klik coin on the curve and fee profile Klik's own form uses", () => {
    const tx = buildCreateTx(1, ME, klik(parseEther('0.05')));
    expect(decodeFunctionData({ abi: klikAbi, data: tx.data }).args).toEqual([
      'Nesty Test',
      'CTEST',
      IMAGE,
      SALT,
      KLIK_CONFIG,
      KLIK_PROFILE,
    ]);
    expect([KLIK_CONFIG, KLIK_PROFILE]).toEqual([1n, 8n]);
    expect(tx).toMatchObject({ to: KLIK_FACTORY, value: parseEther('0.05') });
    expect(() => buildCreateTx(8453, ME, klik())).toThrow(/Klik does not create coins here/);
  });

  it('pays Pons exactly its fee, and its creator tax to the creator', () => {
    const tx = buildCreateTx(4663, ME, pons());
    const { args } = decodeFunctionData({ abi: ponsLaunchAbi, data: tx.data });
    expect(args[0]).toMatchObject({
      creatorFeeRecipient: ME,
      creatorTaxBps: 100,
      buybackEnabled: false,
      expectedEconomics: zeroHash,
      socials: {
        twitter: 'https://x.com/nesty',
        telegram: '',
        discord: '',
        website: '',
        farcaster: '',
      },
    });
    expect(args.slice(1)).toEqual([0n, zeroAddress]);
    expect(tx).toMatchObject({ to: PONS_LAUNCH_FACTORY, value: parseEther('0.0005') });
    expect(createValue(pons())).toBe(parseEther('0.0005'));
    expect(createValue(klik(7n))).toBe(7n);
    expect(() => buildCreateTx(1, ME, pons())).toThrow(/Pons does not create coins here/);
  });

  it('finds the new coin in the receipt, only in what its factory logged', () => {
    const klikLog = (from: Address) =>
      log(
        from,
        encodeEventTopics({ abi: klikAbi, eventName: 'ERC20TokenCreated' }),
        encodeAbiParameters([{ type: 'address' }], [TOKEN]),
      );
    expect(createdToken(1, klik(), [klikLog(KLIK_FACTORY)])).toBe(TOKEN);
    expect(createdToken(1, klik(), [klikLog(OTHER)])).toBeNull();

    const launched = log(
      PONS_LAUNCH_FACTORY,
      encodeEventTopics({
        abi: ponsLaunchAbi,
        eventName: 'TokenLaunched',
        args: { token: TOKEN, curve: OTHER, deployer: ME },
      }),
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
        [zeroAddress, 0n, 1n],
      ),
    );
    expect(createdToken(4663, pons(), [launched])).toBe(TOKEN);

    // Flap's coin is where its salt puts it, once the portal has logged anything.
    const portal = buildCreateTx(56, ME, flap(100)).to;
    expect(createdToken(56, flap(100), [log(portal, [])])).toBe(flapTokenAddress(56, 100, SALT));
    expect(createdToken(56, flap(100), [log(OTHER, [])])).toBeNull();
  });
});

describe('what a new coin may be called and link to', () => {
  it('offers each launchpad on the chains it creates coins on', () => {
    const ids = (chainId: number) => launchpadsOn(chainId).map((l) => l.id);
    expect(ids(SOLANA_CHAIN_ID)).toEqual(['pump']);
    expect(ids(56)).toEqual(['flap']);
    expect(ids(8453)).toEqual(['flap', 'clanker']);
    expect(ids(4663)).toEqual(['flap', 'pons']);
    expect(ids(1)).toEqual(['clanker', 'klik']);
    expect(flapTaxes(56)).toEqual([100, 300, 500, 1000]);
    expect(flapTaxes(4663)).toEqual([0, 100, 300, 500, 1000]);
  });

  it('counts a name in bytes, as the launchpads do', () => {
    expect(textProblem('name', '', 32)).toBe('Enter a name.');
    expect(textProblem('symbol', '', 10)).toBe('Enter a ticker.');
    expect(textProblem('description', '', 500)).toBeNull();
    expect(textProblem('name', 'a'.repeat(32), 32)).toBeNull();
    // 29 letters and a 4-byte emoji: 33 bytes, one over.
    expect(textProblem('name', `${'a'.repeat(29)}🐱`, 32)).toBe('Too long: 32 bytes at most.');
  });

  it('refuses hidden characters and stray spaces, allowing lines in a description', () => {
    expect(textProblem('name', 'Nesty‮Test', 32)).toBe('Remove the hidden characters.');
    expect(textProblem('symbol', 'CT​EST', 10)).toBe('Remove the hidden characters.');
    expect(textProblem('name', 'Line\nbreak', 32)).toBe('Remove the hidden characters.');
    expect(textProblem('description', 'Line one\nLine two', 500)).toBeNull();
    expect(textProblem('name', ' Nesty', 32)).toBe('Remove the spaces at the start or end.');
  });

  it('takes only full https links, and x.com or t.me where the field says so', () => {
    expect(linkProblem('website', '', 200)).toBeNull();
    expect(linkProblem('website', 'https://nesty.example/coin', 200)).toBeNull();
    for (const bad of [
      'http://nesty.example',
      'nesty.example',
      'https://user:pw@nesty.example',
      'https://localhost',
      'https://nesty.example/a b',
    ])
      expect(linkProblem('website', bad, 200)).toBe('Enter a full link, starting with https://');
    expect(linkProblem('x', 'https://x.com/nesty', 200)).toBeNull();
    expect(linkProblem('x', 'https://www.twitter.com/nesty', 200)).toBeNull();
    expect(linkProblem('x', 'https://nesty.example/x', 200)).toBe('Use an x.com link.');
    expect(linkProblem('telegram', 'https://t.me/nesty', 200)).toBeNull();
    expect(linkProblem('telegram', 'https://x.com/nesty', 200)).toBe('Use a t.me link.');
    expect(linkProblem('website', `https://nesty.example/${'a'.repeat(200)}`, 200)).toBe(
      'Too long: 200 bytes at most.',
    );
  });

  it("holds a coin to its launchpad's chains, taxes and addresses", () => {
    expect(createSpecProblem(8453, flap(100))).toBeNull();
    expect(createSpecProblem(1, flap(100))).toBe('Flap does not create coins here.');
    expect(createSpecProblem(4663, flap(0))).toBeNull();
    expect(createSpecProblem(56, flap(0))).toBe('Flap does not take this tax.');
    expect(createSpecProblem(56, flap(200))).toBe('Flap does not take this tax.');
    expect(createSpecProblem(56, { ...flap(100), meta: 'not-a-cid' })).toBe(
      'Bad metadata address.',
    );
    expect(createSpecProblem(56, { ...flap(100), salt: `0x${'AB'.repeat(32)}` })).toBe('Bad salt.');
    expect(createSpecProblem(8453, clanker())).toBeNull();
    expect(createSpecProblem(8453, { ...clanker(), image: 'ipfs://nope' })).toBe(
      'Bad IPFS address.',
    );
    expect(createSpecProblem(8453, { ...clanker(), image: 'http://nesty.example/a.png' })).toBe(
      'Bad image address.',
    );
    expect(createSpecProblem(8453, { ...clanker(), metadata: 'x'.repeat(2049) })).toBe(
      'Its details are too long.',
    );
    expect(createSpecProblem(1, klik())).toBeNull();
    expect(createSpecProblem(1, { ...klik(), metadata: 'https://nesty.example/m.json' })).toBe(
      'Bad IPFS address.',
    );
    expect(createSpecProblem(4663, pons())).toBeNull();
    expect(createSpecProblem(4663, { ...pons(), logo: '' })).toBeNull();
    expect(createSpecProblem(4663, { ...pons(), creatorTaxBps: 300 })).toBe(
      'Pons does not take this tax.',
    );
    expect(
      createSpecProblem(4663, {
        ...pons(),
        links: { twitter: 'https://t.me/nesty', telegram: '', website: '' },
      }),
    ).toBe('Use an x.com link.');
    expect(createSpecProblem(4663, { ...pons(), name: 'a'.repeat(65) })).toBe(
      'Too long: 64 bytes at most.',
    );
  });

  it("holds a pump.fun coin to the program's limits", () => {
    const intent: SolCreateIntent = {
      kind: 'create',
      launchpad: 'pump',
      mint: 'CTestMint1111111111111111111111111111111111',
      name: 'Nesty Test',
      symbol: 'CTEST',
      uri: `https://gateway.pinata.cloud/ipfs/${CID}`,
      devBuy: '0',
      minOut: '0',
    };
    expect(createIntentProblem(intent)).toBeNull();
    expect(createIntentProblem({ ...intent, symbol: 'A'.repeat(14) })).toBe(
      'Too long: 13 bytes at most.',
    );
    expect(
      createIntentProblem({ ...intent, uri: `https://nesty.example/${'a'.repeat(180)}` }),
    ).toBe('Its metadata address is too long.');
    expect(createIntentProblem({ ...intent, uri: 'http://nesty.example/m.json' })).toBe(
      'Bad image address.',
    );
  });
});
