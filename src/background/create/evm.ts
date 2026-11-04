import { keccak_256 } from '@noble/hashes/sha3';
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import type { WireCreateSpec } from '../../shared/site-bridge';
import type { TxDraft } from '../trade/types';

/**
 * The transaction that creates a coin on each EVM launchpad, built the same way by the
 * website (to send it) and the extension (to check what it signs): the creating wallet
 * is the coin's creator, and every fee, reward and dev-bought token goes to it. The
 * parameters are each launchpad's own defaults, as its SDK, docs and recent launches set
 * them; tests/live/create.test.ts runs every one against mainnet.
 */

// ── Flap (BSC, Base, Robinhood) ──────────────────────────────────────────────

interface FlapChain {
  portal: Address;
  /**
   * The untaxed coin's implementation (address suffix 8888), where Flap still launches it
   * to a v2 pool: Robinhood only. On BSC both of its v2 paths now revert with
   * FeatureDisabled, and Base never had one.
   */
  standard?: Address;
  /** Tax Token V3's implementation (suffix 7777). */
  taxed: Address;
}

/** From Flap's deployed-addresses page. */
const FLAP: Record<number, FlapChain> = {
  56: {
    portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    taxed: '0x024f18294970B5c76c0691b87f138A0317156422',
  },
  8453: {
    portal: '0x0000BC1c4fD15Dd79029AF8F5d77D68ae4490000',
    taxed: '0x777782e7EbB89802E2379E5fFcF7336538f43333',
  },
  4663: {
    portal: '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09',
    standard: '0x88882688a067FE97E11C2185b996286e53132222',
    taxed: '0x7777C8743C88B3aff3cf262135beF2c8b2e83333',
  },
};

export const flapAbi = parseAbi([
  'struct NewTokenV5Params { string name; string symbol; string meta; uint8 dexThresh; bytes32 salt; uint16 taxRate; uint8 migratorType; address quoteToken; uint256 quoteAmt; address beneficiary; bytes permitData; bytes32 extensionID; bytes extensionData; uint8 dexId; uint8 lpFeeProfile; uint64 taxDuration; uint64 antiFarmerDuration; uint16 mktBps; uint16 deflationBps; uint16 dividendBps; uint16 lpBps; uint256 minimumShareBalance; }',
  'function newTokenV5(NewTokenV5Params params) payable returns (address)',
  'struct NewTokenV6Params { string name; string symbol; string meta; uint8 dexThresh; bytes32 salt; uint8 migratorType; address quoteToken; uint256 quoteAmt; address beneficiary; bytes permitData; bytes32 extensionID; bytes extensionData; uint8 dexId; uint8 lpFeeProfile; uint16 buyTaxRate; uint16 sellTaxRate; uint64 taxDuration; uint64 antiFarmerDuration; uint16 mktBps; uint16 deflationBps; uint16 dividendBps; uint16 lpBps; uint256 minimumShareBalance; address dividendToken; address commissionReceiver; uint8 tokenVersion; }',
  'function newTokenV6(NewTokenV6Params params) payable returns (address)',
]);

/** Flap's enums, as its docs number them. */
const FOUR_FIFTHS = 1; // DexThreshType: graduates once 80% of the supply has sold
const V2_MIGRATOR = 1; // MigratorType: graduates to a v2 pool, which Nesty trades
const TOKEN_TAXED_V3 = 6;
/** How long the tax lasts and the anti-farmer window, as Flap's own launches set them. */
const TAX_DURATION = 3_153_600_000n; // 100 years
const ANTI_FARMER = 2_592_000n; // 30 days

/** The minimal proxy Flap clones each token from, as its CREATE2 init code. */
const proxyCodeHash = (impl: Address) =>
  keccak_256(
    hexToBytes(
      `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`,
    ),
  );

interface FlapTarget {
  portal: Address;
  impl: Address;
  /** The last two bytes the token's address must end in. */
  suffix: number;
}

function flapTarget(chainId: number, taxBps: number): FlapTarget {
  const f = FLAP[chainId];
  const impl = taxBps === 0 ? f?.standard : f?.taxed;
  if (!f || !impl) throw new Error('Flap does not create this coin here.');
  return { portal: f.portal, impl, suffix: taxBps === 0 ? 0x8888 : 0x7777 };
}

/** keccak256(0xff ‖ portal ‖ salt ‖ codeHash), as one buffer whose salt can be rewritten. */
function create2Buffer(t: FlapTarget): Uint8Array {
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(t.portal), 1);
  buf.set(proxyCodeHash(t.impl), 53);
  return buf;
}

const endsIn = (hash: Uint8Array, suffix: number) =>
  hash[30] === suffix >> 8 && hash[31] === (suffix & 0xff);

/** The address Flap deploys a coin with this salt to. */
export function flapTokenAddress(chainId: number, taxBps: number, salt: Hex): Address {
  const buf = create2Buffer(flapTarget(chainId, taxBps));
  buf.set(hexToBytes(salt), 21);
  return getAddress(bytesToHex(keccak_256(buf).slice(12)));
}

/** Whether a salt gives the address suffix Flap requires (it reverts otherwise). */
export function flapSaltOk(chainId: number, taxBps: number, salt: Hex): boolean {
  const t = flapTarget(chainId, taxBps);
  const buf = create2Buffer(t);
  buf.set(hexToBytes(salt), 21);
  return endsIn(keccak_256(buf), t.suffix);
}

/**
 * A salt whose coin address ends in Flap's suffix: about 65,000 tries on average, from a
 * random start. `pause` lets the page breathe between rounds.
 */
export async function mineFlapSalt(
  chainId: number,
  taxBps: number,
  pause: () => Promise<void> = () => Promise.resolve(),
): Promise<Hex> {
  const t = flapTarget(chainId, taxBps);
  const buf = create2Buffer(t);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const view = new DataView(salt.buffer);
  for (let round = 0; round < 4096; round++) {
    for (let i = 0; i < 4096; i++) {
      view.setUint32(28, round * 4096 + i);
      buf.set(salt, 21);
      if (endsIn(keccak_256(buf), t.suffix)) return bytesToHex(salt);
    }
    await pause();
  }
  throw new Error('No Flap salt found.');
}

function flapTx(
  chainId: number,
  wallet: Address,
  s: Extract<WireCreateSpec, { launchpad: 'flap' }>,
): TxDraft {
  const t = flapTarget(chainId, s.taxBps);
  const devBuy = BigInt(s.devBuy);
  const common = {
    name: s.name,
    symbol: s.symbol,
    meta: s.meta,
    dexThresh: FOUR_FIFTHS,
    salt: s.salt as Hex,
    migratorType: V2_MIGRATOR,
    // Native: the dev buy is paid with the chain's own coin.
    quoteToken: zeroAddress,
    quoteAmt: devBuy,
    beneficiary: wallet,
    permitData: '0x' as Hex,
    extensionID: zeroHash,
    extensionData: '0x' as Hex,
    // The chain's first DEX (PancakeSwap on BSC, Uniswap elsewhere), at its standard fee.
    dexId: 0,
    lpFeeProfile: 0,
    antiFarmerDuration: ANTI_FARMER,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
  };
  const data =
    s.taxBps === 0
      ? // Flap launches its untaxed coin through newTokenV5 (newTokenV6 refuses it).
        encodeFunctionData({
          abi: flapAbi,
          functionName: 'newTokenV5',
          args: [{ ...common, taxRate: 0, taxDuration: 0n, mktBps: 0 }],
        })
      : encodeFunctionData({
          abi: flapAbi,
          functionName: 'newTokenV6',
          args: [
            {
              ...common,
              buyTaxRate: s.taxBps,
              sellTaxRate: s.taxBps,
              taxDuration: TAX_DURATION,
              // All of the tax to the creator (after Flap's own share).
              mktBps: 10_000,
              dividendToken: zeroAddress,
              // Flap's commission for the interface: none taken.
              commissionReceiver: zeroAddress,
              tokenVersion: TOKEN_TAXED_V3,
            },
          ],
        });
  return { to: t.portal, data, value: devBuy };
}

// ── Clanker v4 (Base, Ethereum) ──────────────────────────────────────────────

interface ClankerChain {
  factory: Address;
  locker: Address;
  devBuy: Address;
  mevModule: Address;
  /** The static-fee hook (v4.1). */
  hook: Address;
  weth: Address;
}

/** From clanker-sdk's v4 configuration, and Clanker's own recent launches. */
const CLANKER: Record<number, ClankerChain> = {
  8453: {
    factory: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    locker: '0xffA37784D619F228D8B379d287a4D7282e500762',
    devBuy: '0x1331f0788F9c08C8F38D52c7a1152250A9dE00be',
    mevModule: '0xebB25BB797D82CB78E1bc70406b13233c0854413',
    hook: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
    weth: '0x4200000000000000000000000000000000000006',
  },
  1: {
    factory: '0x6C8599779B03B00AAaE63C6378830919Abb75473',
    // The SDK still names an older locker, which the factory no longer takes (LockerNotEnabled).
    locker: '0x00C4b21889145CF0D99f2e05919103e0c3991974',
    devBuy: '0x70aDdc06fE89a5cF9E533aea8D025dB06795e492',
    mevModule: '0x33e2Eda238edcF470309b8c6D228986A1204c8f9',
    hook: '0x6C24D0bCC264EF6A740754A11cA579b9d225e8Cc',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

export const clankerAbi = parseAbi([
  'struct TokenConfig { address tokenAdmin; string name; string symbol; bytes32 salt; string image; string metadata; string context; uint256 originatingChainId; }',
  'struct PoolConfig { address hook; address pairedToken; int24 tickIfToken0IsClanker; int24 tickSpacing; bytes poolData; }',
  'struct LockerConfig { address locker; address[] rewardAdmins; address[] rewardRecipients; uint16[] rewardBps; int24[] tickLower; int24[] tickUpper; uint16[] positionBps; bytes lockerData; }',
  'struct MevModuleConfig { address mevModule; bytes mevModuleData; }',
  'struct ExtensionConfig { address extension; uint256 msgValue; uint16 extensionBps; bytes extensionData; }',
  'struct DeploymentConfig { TokenConfig tokenConfig; PoolConfig poolConfig; LockerConfig lockerConfig; MevModuleConfig mevModuleConfig; ExtensionConfig[] extensionConfigs; }',
  'function deployToken(DeploymentConfig deploymentConfig) payable returns (address tokenAddress)',
  'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)',
]);

/** The SDK's defaults: a WETH pool from ~$27k, one position up to ~$1.5B. */
const CLANKER_START_TICK = -230_400;
const CLANKER_TICK_SPACING = 200;
const CLANKER_TOP_TICK = -120_000;
/** A 1% fee on each side of every swap (in Uniswap's millionths). */
const CLANKER_FEE = 10_000;
/** The sniper fee: 66.68% at launch, down to 4.17% over 15 seconds. */
const SNIPER = { startingFee: 666_777, endingFee: 41_673, secondsToDecay: 15n };
/** Which context Clanker shows the coin was made through. */
const CLANKER_CONTEXT = JSON.stringify({ interface: 'Nesty' });

function clankerTx(
  chainId: number,
  wallet: Address,
  s: Extract<WireCreateSpec, { launchpad: 'clanker' }>,
): TxDraft {
  const c = CLANKER[chainId];
  if (!c) throw new Error('Clanker does not create coins here.');
  const devBuy = BigInt(s.devBuy);
  const feeData = encodeAbiParameters(
    [{ type: 'uint24' }, { type: 'uint24' }],
    [CLANKER_FEE, CLANKER_FEE],
  );
  const poolData = encodeAbiParameters(
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
    [{ extension: zeroAddress, extensionData: '0x', feeData }],
  );
  // Fee preference "Both": the creator's rewards are paid in the coin and in WETH.
  const lockerData = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'feePreference', type: 'uint8[]' }] }],
    [{ feePreference: [0] }],
  );
  const mevModuleData = encodeAbiParameters(
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
    [SNIPER],
  );
  // The dev buy: ETH straight into the coin's WETH pool (no pool to swap through first).
  const devBuyData = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { type: 'uint128' },
      { type: 'address' },
    ],
    [
      {
        currency0: zeroAddress,
        currency1: zeroAddress,
        fee: 0,
        tickSpacing: 0,
        hooks: zeroAddress,
      },
      0n,
      wallet,
    ],
  );
  return {
    to: c.factory,
    data: encodeFunctionData({
      abi: clankerAbi,
      functionName: 'deployToken',
      args: [
        {
          tokenConfig: {
            tokenAdmin: wallet,
            name: s.name,
            symbol: s.symbol,
            salt: s.salt as Hex,
            image: s.image,
            metadata: s.metadata,
            context: CLANKER_CONTEXT,
            originatingChainId: BigInt(chainId),
          },
          poolConfig: {
            hook: c.hook,
            pairedToken: c.weth,
            tickIfToken0IsClanker: CLANKER_START_TICK,
            tickSpacing: CLANKER_TICK_SPACING,
            poolData,
          },
          lockerConfig: {
            locker: c.locker,
            rewardAdmins: [wallet],
            rewardRecipients: [wallet],
            rewardBps: [10_000],
            tickLower: [CLANKER_START_TICK],
            tickUpper: [CLANKER_TOP_TICK],
            positionBps: [10_000],
            lockerData,
          },
          mevModuleConfig: { mevModule: c.mevModule, mevModuleData },
          extensionConfigs:
            devBuy > 0n
              ? [
                  {
                    extension: c.devBuy,
                    msgValue: devBuy,
                    extensionBps: 0,
                    extensionData: devBuyData,
                  },
                ]
              : [],
        },
      ],
    }),
    value: devBuy,
  };
}

// ── Klik (Ethereum) ──────────────────────────────────────────────────────────

export const KLIK_FACTORY: Address = '0xdfb7fe5e4ea0504afee387c42bb86e5860d29e8a';
/** A classic coin on the curve Klik's own form uses: it opens at a 1 ETH market cap. */
export const KLIK_CONFIG = 1n;
/**
 * The hook profile every launch from Klik's form uses (the factory has no default hook,
 * so a plain deployCoin reverts). Its economics are fixed once made: see KLIK_FEES.
 */
export const KLIK_PROFILE = 8n;

export const klikAbi = parseAbi([
  'function deployCoinWithHook(string _name, string _symbol, string _metadata, bytes32 salt, uint256 configId, uint256 hookProfileId) payable returns (uint256 tokensReceived)',
  'event ERC20TokenCreated(address tokenAddress)',
]);

function klikTx(s: Extract<WireCreateSpec, { launchpad: 'klik' }>): TxDraft {
  return {
    to: KLIK_FACTORY,
    data: encodeFunctionData({
      abi: klikAbi,
      functionName: 'deployCoinWithHook',
      args: [s.name, s.symbol, s.metadata, s.salt as Hex, KLIK_CONFIG, KLIK_PROFILE],
    }),
    // All of it buys the coin, in the same block it opens (no fee then).
    value: BigInt(s.devBuy),
  };
}

// ── Pons (Robinhood) ─────────────────────────────────────────────────────────

export const PONS_LAUNCH_FACTORY: Address = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

export const ponsLaunchAbi = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function launchFee() view returns (uint256)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

function ponsTx(wallet: Address, s: Extract<WireCreateSpec, { launchpad: 'pons' }>): TxDraft {
  return {
    to: PONS_LAUNCH_FACTORY,
    data: encodeFunctionData({
      abi: ponsLaunchAbi,
      functionName: 'launchToken',
      args: [
        {
          name: s.name,
          symbol: s.symbol,
          logo: s.logo,
          description: s.description,
          socials: {
            twitter: s.links.twitter,
            telegram: s.links.telegram,
            discord: '',
            website: s.links.website,
            farcaster: '',
          },
          creatorFeeRecipient: wallet,
          creatorTaxBps: s.creatorTaxBps,
          // The creator's fee share is paid out, not spent on buybacks.
          buybackEnabled: false,
          // Zero takes the launch terms as they are when it lands.
          expectedEconomics: zeroHash,
          salt: s.salt as Hex,
        },
        // The only launch configuration, paired with native ETH.
        0n,
        zeroAddress,
      ],
    }),
    value: BigInt(s.fee),
  };
}

// ── all launchpads ───────────────────────────────────────────────────────────

/** The transaction creating `spec` on `chainId`, from `wallet`. */
export function buildCreateTx(chainId: number, wallet: Address, spec: WireCreateSpec): TxDraft {
  switch (spec.launchpad) {
    case 'flap':
      return flapTx(chainId, wallet, spec);
    case 'clanker':
      return clankerTx(chainId, wallet, spec);
    case 'klik':
      if (chainId !== 1) throw new Error('Klik does not create coins here.');
      return klikTx(spec);
    case 'pons':
      if (chainId !== 4663) throw new Error('Pons does not create coins here.');
      return ponsTx(wallet, spec);
  }
}

/** What the transaction spends besides gas: the dev buy, or Pons' launch fee. */
export const createValue = (spec: WireCreateSpec): bigint =>
  BigInt(spec.launchpad === 'pons' ? spec.fee : spec.devBuy);

/** The coin a create transaction made, from its receipt's logs; null when none is there. */
export function createdToken(
  chainId: number,
  spec: WireCreateSpec,
  logs: readonly Log[],
): Address | null {
  const from = (address: Address) =>
    logs.filter((l) => l.address.toLowerCase() === address.toLowerCase());
  switch (spec.launchpad) {
    case 'flap': {
      // CREATE2: where the salt says, once the portal has emitted for it.
      const token = flapTokenAddress(chainId, spec.taxBps, spec.salt as Hex);
      const portal = FLAP[chainId]?.portal;
      return portal && from(portal).length > 0 ? token : null;
    }
    case 'clanker': {
      const c = CLANKER[chainId];
      const ev = c
        ? parseEventLogs({ abi: clankerAbi, eventName: 'TokenCreated', logs: from(c.factory) })
        : [];
      return ev[0]?.args.tokenAddress ?? null;
    }
    case 'klik': {
      const ev = parseEventLogs({
        abi: klikAbi,
        eventName: 'ERC20TokenCreated',
        logs: from(KLIK_FACTORY),
      });
      return ev[0]?.args.tokenAddress ?? null;
    }
    case 'pons': {
      const ev = parseEventLogs({
        abi: ponsLaunchAbi,
        eventName: 'TokenLaunched',
        logs: from(PONS_LAUNCH_FACTORY),
      });
      return ev[0]?.args.token ?? null;
    }
  }
}
