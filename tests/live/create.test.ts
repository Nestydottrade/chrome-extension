import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { bytesToHex, parseAbi, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import {
  KLIK_CONFIG,
  KLIK_FACTORY,
  KLIK_PROFILE,
  PONS_LAUNCH_FACTORY,
  buildCreateTx,
  createdToken,
  flapSaltOk,
  flapTokenAddress,
  mineFlapSalt,
  ponsLaunchAbi,
} from '../../src/background/create/evm';
import {
  PUMP_DECIMALS,
  createInstructions,
  devBuyQuote,
  freshRoute,
} from '../../src/background/create/pump';
import {
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  decodeFeeConfig,
  decodeGlobal,
  pickRecipients,
} from '../../src/background/solana/pump';
import { setComputeUnitLimit, setComputeUnitPrice } from '../../src/background/solana/spl';
import { compileMessage, serializeTransaction } from '../../src/background/solana/tx';
import { getChain } from '../../src/shared/chains';
import { KLIK_FEES, LAUNCHPADS, PUMP_URI_MAX } from '../../src/shared/create';
import type { WireCreateSpec } from '../../src/shared/site-bridge';
import { rpc } from './solana-sim';

/**
 * Every create transaction Nesty builds, run against mainnet state without funds: EVM
 * through eth_simulateV1 from a throwaway key with a balance override, pump.fun through
 * simulateTransaction (signatures not checked) from a wallet that holds SOL. Also pins
 * pump.fun's text limits, which the program enforces.
 */
const pool = new ClientPool();
const META_CID = 'bafkreiestszrbvwiv5nnu4tt4o2ltnx7p5oesfwzgupdz4dhdmxftu6kva';
const IMAGE = `ipfs://${META_CID}`;
const salt = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

async function simulate(chainId: number, spec: WireCreateSpec) {
  const chain = getChain(chainId);
  if (!chain) throw new Error('chain');
  const client = pool.get(chain);
  const account = privateKeyToAccount(generatePrivateKey());
  const tx = buildCreateTx(chainId, account.address, spec);
  const sim = await client.simulateCalls({
    account: account.address,
    stateOverrides: [{ address: account.address, balance: parseEther('10') }],
    calls: [{ to: tx.to, data: tx.data, value: tx.value }],
  });
  const r = sim.results[0];
  return {
    status: r?.status,
    error: r?.status === 'failure' ? r.error?.message?.slice(0, 300) : '',
    gas: r?.gasUsed,
    token: r ? createdToken(chainId, spec, r.logs ?? []) : null,
    data: r?.data,
    wallet: account.address,
  };
}

const flap = async (chainId: number, taxBps: number, devBuy: bigint) => {
  const s = await mineFlapSalt(chainId, taxBps);
  expect(flapSaltOk(chainId, taxBps, s)).toBe(true);
  const spec: WireCreateSpec = {
    launchpad: 'flap',
    name: 'Nesty Test',
    symbol: 'CTEST',
    meta: META_CID,
    taxBps,
    salt: s,
    devBuy: devBuy.toString(),
  };
  const r = await simulate(chainId, spec);
  expect(r.status, r.error).toBe('success');
  expect(r.token).toBe(flapTokenAddress(chainId, taxBps, s as Hex));
  console.log('flap', chainId, taxBps, devBuy, 'gas', r.gas, r.token);
};

describe('Flap newTokenV6 (mainnet simulation)', () => {
  it('BSC: 1% tax coin, no dev buy', () => flap(56, 100, 0n));
  it('BSC: 3% tax coin with a dev buy', () => flap(56, 300, parseEther('0.01')));
  it('BSC: no untaxed coin (Flap refuses it on v2)', () =>
    expect(() => flapTokenAddress(56, 0, salt() as Hex)).toThrow());
  it('Base: 1% tax coin with a dev buy', () => flap(8453, 100, parseEther('0.001')));
  it('Robinhood: standard coin with a dev buy', () => flap(4663, 0, parseEther('0.001')));
  it('Robinhood: 10% tax coin', () => flap(4663, 1000, 0n));
});

const clanker = async (chainId: number, devBuy: bigint) => {
  const r = await simulate(chainId, {
    launchpad: 'clanker',
    name: 'Nesty Test',
    symbol: 'CTEST',
    image: IMAGE,
    metadata: JSON.stringify({ description: 'A test', socialMediaUrls: [] }),
    salt: salt(),
    devBuy: devBuy.toString(),
  });
  expect(r.status, r.error).toBe('success');
  expect(r.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
  console.log('clanker', chainId, devBuy, 'gas', r.gas, r.token);
};

describe('Clanker v4 deployToken (mainnet simulation)', () => {
  it('Base: no dev buy', () => clanker(8453, 0n));
  it('Base: with a dev buy', () => clanker(8453, parseEther('0.001')));
  it('Ethereum: with a dev buy', () => clanker(1, parseEther('0.001')));
});

describe('Klik deployCoin (mainnet simulation)', () => {
  const klik = async (devBuy: bigint) => {
    const r = await simulate(1, {
      launchpad: 'klik',
      name: 'Nesty Test',
      symbol: 'CTEST',
      metadata: IMAGE,
      salt: salt(),
      devBuy: devBuy.toString(),
    });
    expect(r.status, r.error).toBe('success');
    expect(r.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log('klik', devBuy, 'gas', r.gas, r.token, 'tokens', r.data);
  };
  it('no dev buy', () => klik(0n));
  it('with a dev buy', () => klik(parseEther('0.001')));
});

describe('Pons launchToken (mainnet simulation)', () => {
  it('Robinhood: pays exactly the launch fee', async () => {
    const chain = getChain(4663);
    if (!chain) throw new Error('chain');
    const fee = await pool.get(chain).readContract({
      address: PONS_LAUNCH_FACTORY,
      abi: ponsLaunchAbi,
      functionName: 'launchFee',
    });
    const spec = (creatorTaxBps: number, f: bigint): WireCreateSpec => ({
      launchpad: 'pons',
      name: 'Nesty Test',
      symbol: 'CTEST',
      logo: IMAGE,
      description: 'A test',
      links: { twitter: 'https://x.com/nesty', telegram: '', website: 'https://nesty.example' },
      creatorTaxBps,
      salt: salt(),
      fee: f.toString(),
    });
    const ok = await simulate(4663, spec(200, fee));
    expect(ok.status, ok.error).toBe('success');
    expect(ok.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log('pons gas', ok.gas, ok.token, 'fee', fee);
    // Anything but the fee is refused.
    const off = await simulate(4663, spec(0, fee + 1n));
    expect(off.status).toBe('failure');
  });
});

describe('Klik launch terms read from chain', () => {
  it('config 1 is a classic coin, and profile 8 charges what Nesty shows', async () => {
    const chain = getChain(1);
    if (!chain) throw new Error('chain');
    const c = pool.get(chain);
    const abi = parseAbi([
      'function configModes(uint256) view returns (uint8)',
      'function hookRegistry() view returns (address)',
      'function previewDeploy(uint256 configId, uint256 ethValue) view returns ((bool wouldLaunch, string blocker, uint256 startMarketCapETH, uint256 estimatedTokensOut, uint256 shareOfSupplyBps, uint256 marketCapAfterBuyETH))',
      'function resolveProfile(uint256) view returns (address hook, address creator, (uint16 buyTaxBps, uint16 sellTaxBps, uint16 decayStartBps, uint32 decaySeconds, uint16 surchargeMaxBps, uint32 surchargeWindow, uint128 surchargeVolumeRef, uint16 platformBps, uint16 hookCreatorBps, uint16 tokenCreatorBps, uint16 buybackBps, uint16 rewardsBps) config)',
    ]);
    const read = <T>(functionName: 'configModes' | 'previewDeploy', args: bigint[]) =>
      c.readContract({ address: KLIK_FACTORY, abi, functionName, args } as never) as Promise<T>;
    expect(await read<number>('configModes', [KLIK_CONFIG])).toBe(0);
    const preview = await read<{ wouldLaunch: boolean; startMarketCapETH: bigint }>(
      'previewDeploy',
      [KLIK_CONFIG, parseEther('0.1')],
    );
    expect(preview.wouldLaunch).toBe(true);
    expect(preview.startMarketCapETH).toBe(parseEther('1'));
    const registry = await c.readContract({
      address: KLIK_FACTORY,
      abi,
      functionName: 'hookRegistry',
    });
    const [, , cfg] = await c.readContract({
      address: registry,
      abi,
      functionName: 'resolveProfile',
      args: [KLIK_PROFILE],
    });
    expect(cfg.buyTaxBps).toBe(KLIK_FEES.buyBps);
    expect(cfg.sellTaxBps).toBe(KLIK_FEES.sellBps);
    expect(cfg.surchargeMaxBps).toBe(KLIK_FEES.busyExtraBps);
    expect(cfg.tokenCreatorBps).toBe(KLIK_FEES.creatorShareBps);
    // Holder rewards need a reward token; config 1 makes a classic one.
    expect(cfg.rewardsBps).toBe(0);
  });
});

// ── pump.fun ────────────────────────────────────────────────────────────────

/** A wallet that holds SOL, to pay in simulations (nothing is signed or sent). */
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

async function pumpSim(p: { name: string; symbol: string; uri: string; devBuy: bigint }) {
  const [g, f] = await rpc.getMultipleAccounts([PUMP_GLOBAL, PUMP_FEE_CONFIG]);
  const global = g && decodeGlobal(g.data);
  const feeConfig = f && decodeFeeConfig(f.data);
  if (!global?.launch || !feeConfig) throw new Error('pump.fun accounts');
  expect(global.launch.createV2Enabled).toBe(true);
  const mint = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const route = freshRoute(mint, PAYER, global, global.launch, feeConfig);
  const quoted = devBuyQuote(route, p.devBuy);
  const rec = p.devBuy > 0n ? pickRecipients(route) : null;
  const ixs = [
    setComputeUnitLimit(400_000),
    setComputeUnitPrice(1_000n),
    ...createInstructions({ user: PAYER, mint, ...p, minOut: (quoted * 99n) / 100n }, route, rec),
  ];
  const { blockhash } = await rpc.getLatestBlockhash();
  const message = compileMessage(PAYER, ixs, blockhash);
  const raw = serializeTransaction(message, []);
  const sim = await rpc.simulate(raw);
  return { sim, quoted, size: raw.length, signers: message.numSigners, accounts: message.accounts };
}

describe('pump.fun create_v2 (mainnet simulation)', () => {
  it('creates with a dev buy, in one legacy transaction', async () => {
    const r = await pumpSim({
      name: 'Nesty Test',
      symbol: 'CTEST',
      uri: 'https://ipfs.io/ipfs/' + META_CID,
      devBuy: 100_000_000n,
    });
    console.log(
      'pump create+buy',
      r.sim.err,
      r.sim.unitsConsumed,
      'bytes',
      r.size,
      'tokens',
      Number(r.quoted) / 10 ** PUMP_DECIMALS,
    );
    if (r.sim.err) console.log(r.sim.logs.slice(-15).join('\n'));
    expect(r.sim.err).toBeNull();
    expect(r.signers).toBe(2);
    // The payer signs first, then the new coin's own key.
    expect(r.accounts[0]).toBe(PAYER);
  });

  it('holds names, tickers and URIs to the program limits', async () => {
    const { nameMax, symbolMax } = LAUNCHPADS.pump;
    const uri = 'https://ipfs.io/ipfs/' + META_CID;
    const uriOf = (bytes: number) => uri + '?' + 'u'.repeat(bytes - uri.length - 1);
    const at = (name: string, symbol: string, u: string) =>
      pumpSim({ name, symbol, uri: u, devBuy: 0n }).then((r) => r.sim);
    const fits = await at('N'.repeat(nameMax), 'S'.repeat(symbolMax), uriOf(PUMP_URI_MAX));
    expect(fits.err).toBeNull();
    const errorOf = (s: { logs: string[] }) => s.logs.find((l) => l.includes('Error Code'));
    expect(errorOf(await at('N'.repeat(nameMax + 1), 'CTEST', uri))).toContain('NameTooLong');
    expect(errorOf(await at('Nesty Test', 'S'.repeat(symbolMax + 1), uri))).toContain(
      'SymbolTooLong',
    );
    expect(errorOf(await at('Nesty Test', 'CTEST', uriOf(PUMP_URI_MAX + 1)))).toContain(
      'UriTooLong',
    );
  });
});
