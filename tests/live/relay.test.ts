import { base58 } from '@scure/base';
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { SYSTEM_PROGRAM } from '../../src/background/solana/address';
import {
  DEPOSIT_UNITS,
  RELAY_SOLANA_PROGRAM,
  relayDepositNative,
} from '../../src/background/solana/relay';
import { SolRpc } from '../../src/background/solana/rpc';
import { setComputeUnitLimit, setComputeUnitPrice } from '../../src/background/solana/spl';
import { compileMessage, serializeTransaction } from '../../src/background/solana/tx';
import { validateRelayDeposit } from '../../src/background/solana/validator';
import { createRelayClient } from '../../src/background/trade/relay';
import { getChain } from '../../src/shared/chains';
import { SOLANA, SOLANA_CHAIN_ID } from '../../src/shared/solana';

/** Real Relay quotes, checked by checkQuote(), and the deposit simulated (no funds). */
const relay = createRelayClient();
const pool = new ClientPool();
// Reading history: api.mainnet-beta answers that here (no Origin), though it refuses the
// extension. The extension itself uses the built-in endpoint.
const solRpc = new SolRpc(['https://api.mainnet-beta.solana.com', ...SOLANA.rpcUrls]);

const evmWallet = () => privateKeyToAccount(generatePrivateKey()).address;

/** Simulates `calls` from `from` on an EVM chain, with 1 of its native coin to spend. */
async function simulateEvm(
  chainId: number,
  from: `0x${string}`,
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint },
) {
  const sim = await pool.get(getChain(chainId)!).simulateCalls({
    account: from,
    stateOverrides: [{ address: from, balance: parseEther('1') }],
    calls: [tx],
  });
  return sim.results[0];
}

describe('Relay bridge (live quote + simulated deposit)', () => {
  const routes: [number, number, string][] = [
    [8453, 56, '0.005'],
    [56, 8453, '0.02'],
    [4663, 8453, '0.003'],
    [1, 8453, '0.005'],
    [8453, 4663, '0.003'],
  ];
  for (const [from, to, amount] of routes) {
    it(`${from} → ${to}`, async () => {
      const me = evmWallet();
      const q = await relay.quote({
        user: me,
        recipient: evmWallet(),
        fromChainId: from,
        toChainId: to,
        amount: parseEther(amount),
      });
      expect(q.amountOut).toBeGreaterThan(0n);
      // checkQuote() already refused anything looser than the slippage asked for.
      expect(q.minOut).toBeGreaterThan(0n);
      expect(q.minOut).toBeLessThanOrEqual(q.amountOut);
      const result = await simulateEvm(from, me, q.tx);
      expect(result?.status, JSON.stringify(result?.error?.message ?? '')).toBe('success');
    });
  }
});

/**
 * A wallet that used Relay's Solana depository lately and still holds `min` lamports: the
 * deposit is simulated from it, so no address is hard-coded.
 */
async function relayUser(min: bigint): Promise<string> {
  const sigs = await solRpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [
    RELAY_SOLANA_PROGRAM,
    { limit: 40, commitment: 'confirmed' },
  ]);
  const tried = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await solRpc
      .call<{ transaction: { message: { accountKeys: string[] } } } | null>('getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ])
      .catch(() => null);
    const payer = tx?.transaction.message.accountKeys[0];
    if (!payer || tried.has(payer)) continue;
    tried.add(payer);
    const acc = await solRpc.getAccount(payer);
    // A plain wallet holding enough.
    if (acc && acc.owner === SYSTEM_PROGRAM && acc.data.length === 0 && acc.lamports >= min)
      return payer;
  }
  throw new Error('No recent Relay user holds enough SOL');
}

describe('Relay bridge with Solana (live quote + simulated deposit)', () => {
  it('8453 → Solana: pays a base58 wallet in SOL, enough for a new one to exist', async () => {
    const me = evmWallet();
    // A fresh address: nothing was ever sent to it.
    const recipient = base58.encode(crypto.getRandomValues(new Uint8Array(32)));
    const q = await relay.quote({
      user: me,
      recipient,
      fromChainId: 8453,
      toChainId: SOLANA_CHAIN_ID,
      amount: parseEther('0.005'),
    });
    expect(q.minOut).toBeLessThanOrEqual(q.amountOut);
    expect(q.minOut).toBeGreaterThanOrEqual(await solRpc.minimumBalance(0));
    const result = await simulateEvm(8453, me, q.tx);
    expect(result?.status, JSON.stringify(result?.error?.message ?? '')).toBe('success');
  });

  it('Solana → 8453: the deposit Nesty builds passes its validator and simulates', async () => {
    const amount = 50_000_000n;
    const payer = await relayUser(amount + 20_000_000n);
    const q = await relay.quoteFromSolana({
      user: payer,
      recipient: evmWallet(),
      toChainId: 8453,
      amount,
    });
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.minOut).toBeLessThanOrEqual(q.amountOut);

    const ixs = [
      setComputeUnitLimit(DEPOSIT_UNITS),
      setComputeUnitPrice(1_000n),
      relayDepositNative(payer, amount, q.depositId),
    ];
    const verdict = validateRelayDeposit(ixs, {
      wallet: payer,
      amount,
      id: q.depositId,
      maxSpend: amount,
      maxPriorityLamports: 1_000_000n,
    });
    expect(verdict.actions.filter((a) => !a.ok)).toEqual([]);
    const { blockhash } = await solRpc.getLatestBlockhash();
    const sim = await solRpc.simulate(
      serializeTransaction(compileMessage(payer, ixs, blockhash), []),
    );
    const logs = sim.logs.join('\n');
    expect(sim.err, logs).toBeNull();
    expect(logs).toContain(`Program ${RELAY_SOLANA_PROGRAM} success`);
    // What runLeg asks for when it does not simulate first.
    expect(sim.unitsConsumed ?? Infinity).toBeLessThanOrEqual(DEPOSIT_UNITS);
  });
});
