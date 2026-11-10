import { base58 } from '@scure/base';
import { encodeFunctionData, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
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
import { validationContext } from '../../src/background/trade/engine/core';
import { minOutAfter } from '../../src/background/trade/engine/trading';
import { launchpadRules, launchpadVenues } from '../../src/background/trade/launchpads';
import {
  RELAY_DEPOSITORY,
  createRelayClient,
  relayTokenRule,
} from '../../src/background/trade/relay';
import { Routing } from '../../src/background/trade/routing';
import { buildTx, type VenueCtx } from '../../src/background/trade/types';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { validateTx } from '../../src/background/trade/validator';
import { extraVenues, venueRules } from '../../src/background/trade/venues';
import { bridgeAsset, getChain } from '../../src/shared/chains';
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

describe('Relay bridge out of Elysium in USDC (live quotes + simulated swap, approval, deposit)', () => {
  it('99901 → 8453: HYPE into USDC on the best pool, then the exact approval and the deposit', async () => {
    const chain = getChain(99901)!;
    const via = bridgeAsset(chain)!;
    const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
    const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
    const amount = parseEther('0.5');
    const [route] = await routing.best(ctx, via.address, 'buy', [amount], { own: true });
    if (!route) throw new Error('no HYPE → USDC pool');
    const me = evmWallet();
    // What the flow deposits is what arrived; the swap's least is what is sure to.
    const minOut = minOutAfter(route.out, 0, 100);
    const swap = await buildTx(route.venue, ctx, route.pool, 'buy', {
      wallet: me,
      amountIn: amount,
      minOut,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    });
    const q = await relay.quoteToken({
      user: me,
      recipient: me,
      fromChainId: 99901,
      toChainId: 8453,
      token: via.address,
      amount: minOut,
    });
    expect(q.minOut).toBeGreaterThan(0n);
    expect(q.minOut).toBeLessThanOrEqual(q.amountOut);

    // Each passes the validator as the flow builds it.
    const d = {
      extraContracts: (id: number) => new Map([...venueRules(id), ...launchpadRules(id)]),
      routing,
      now: Date.now,
    };
    const rules = new Map([
      ...d.extraContracts(chain.id),
      [RELAY_DEPOSITORY.toLowerCase(), relayTokenRule(via.address)],
    ]);
    const approve = {
      to: via.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [RELAY_DEPOSITORY, minOut],
      }),
      value: 0n,
    };
    const checks = [
      validateTx(
        swap,
        validationContext(
          d,
          chain,
          me,
          [me],
          { token: via.address, maxValue: amount },
          { ctx, venueId: route.venue.id, pool: route.pool },
        ),
      ),
      validateTx(
        approve,
        validationContext(d, chain, me, [me], {
          token: via.address,
          maxApproval: minOut,
          maxValue: 0n,
          extraContracts: rules,
        }),
      ),
      validateTx(
        q.tx,
        validationContext(d, chain, me, [me], { maxValue: 0n, extraContracts: rules }),
      ),
    ];
    expect(checks.flatMap((c) => c.actions.filter((a) => !a.ok))).toEqual([]);

    const sim = await ctx.client.simulateCalls({
      account: me,
      stateOverrides: [{ address: me, balance: parseEther('2') }],
      calls: [swap, approve, q.tx],
    });
    expect(
      sim.results.map((r) => r.status),
      JSON.stringify(sim.results.map((r) => r.error?.message ?? '')),
    ).toEqual(['success', 'success', 'success']);
  });
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
