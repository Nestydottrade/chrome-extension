import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  associatedTokenAddress,
  findProgramAddress,
  seed,
} from '../src/background/solana/address';
import { dexModule, type DexVenue } from '../src/background/solana/dex';
import { whirlpoolAddresses } from '../src/background/solana/dex/orca';
import type { RaydiumAmmVenue } from '../src/background/solana/dex/raydium-amm';
import { EXT, decodeMint } from '../src/background/solana/layouts';
import { SOL_QUOTE } from '../src/background/solana/pump';
import { bestRoute, fundedBest } from '../src/background/solana/routes';
import type { AccountInfo, TxMeta } from '../src/background/solana/rpc';
import { SolanaService, type SolSignRequest } from '../src/background/solana/service';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { BlockedAction, TradeTicket } from '../src/shared/panel';
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

// Made-up addresses for these tests only. Never hold funds.
const address = (name: string) => findProgramAddress([seed(name)], SYSTEM_PROGRAM);
const WALLET = address('nesty-funded-wallet');
const COIN = address('nesty-funded-coin');
const COIN_POOL = address('nesty-funded-coin-pool');
const LEG_POOL = address('nesty-funded-leg-pool');
const THIN_POOL = address('nesty-funded-thin-pool');
const SOL = 1_000_000_000n;
const USDC = 1_000_000n;

/** A Raydium AMM pool of `mint` against `quote`, with these reserves (0.25% fee). */
function pool(
  at: string,
  mint: string,
  quote: RaydiumAmmVenue['quote'],
  coinReserve: bigint,
  quoteReserve: bigint,
): RaydiumAmmVenue {
  return {
    kind: 'dex',
    dex: 'raydium-amm',
    pool: at,
    mint,
    tokenProgram: TOKEN_PROGRAM,
    quote,
    coinIsMint: true,
    status: 1n,
    openTime: 0n,
    feeNumerator: 25n,
    feeDenominator: 10_000n,
    coinVault: address(`coin-vault-${at.slice(0, 12)}`),
    pcVault: address(`quote-vault-${at.slice(0, 12)}`),
    coinReserve,
    pcReserve: quoteReserve,
  };
}

const USDC_QUOTE = { mint: USDC_MINT, program: TOKEN_PROGRAM };
/** The coin, priced in USDC: 1,000,000 coins against 10,000 USDC. */
const coinPool = pool(COIN_POOL, COIN, USDC_QUOTE, 1_000_000n * 10n ** 6n, 10_000n * USDC);
/** USDC against SOL at $150: 1,500,000 USDC against 10,000 SOL. */
const legPool = pool(LEG_POOL, USDC_MINT, SOL_QUOTE, 1_500_000n * USDC, 10_000n * SOL);
/** A shallow one at the same price: pays less for any amount. */
const thinPool = pool(THIN_POOL, USDC_MINT, SOL_QUOTE, 15_000n * USDC, 100n * SOL);

describe('Token-2022 transfer hooks', () => {
  /** A Token-2022 mint whose only extension is a transfer hook naming `program`. */
  function hookMint(program: Uint8Array): Uint8Array {
    const data = new Uint8Array(166 + 4 + 64);
    data[44] = 6; // decimals
    data[45] = 1; // initialized
    data[165] = 1; // account type: mint
    data[166] = EXT.transferHook;
    data[168] = 64;
    data.set(new Uint8Array(32).fill(7), 170); // authority
    data.set(program, 202);
    return data;
  }

  it('reads the program a hook runs, and none for a hook set to no program', () => {
    const program = new Uint8Array(32).fill(9);
    const set = decodeMint(hookMint(program));
    expect(set?.extensions).toEqual([EXT.transferHook]);
    expect(set?.transferHookProgram).toBe(base58.encode(program));
    // AAPLx and the other xStocks carry a hook with no program: transfers run nothing.
    const unset = decodeMint(hookMint(new Uint8Array(32)));
    expect(unset?.extensions).toEqual([EXT.transferHook]);
    expect(unset?.transferHookProgram).toBeUndefined();
  });
});

describe('Orca pools from their addresses', () => {
  it("finds a token's fixed-fee SOL pools whichever mint comes first", () => {
    const pools = whirlpoolAddresses(USDC_MINT, WSOL_MINT);
    // SOL/USDC at tick spacing 4 and 64, as they are on mainnet.
    expect(pools).toContain('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
    expect(pools).toContain('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
    expect(whirlpoolAddresses(WSOL_MINT, USDC_MINT)).toEqual(pools);
  });
});

describe('Trades through SOL', () => {
  it('chains the SOL pool that pays most with the coin route', () => {
    const legs: DexVenue[] = [thinPool, legPool];
    const buy = fundedBest([coinPool], legs, 'buy', SOL);
    const usdc = dexModule(legPool).quote(legPool, 'buy', SOL);
    expect(buy).toMatchObject({ route: coinPool, leg: legPool, mid: usdc });
    expect(buy?.out).toBe(dexModule(coinPool).quote(coinPool, 'buy', usdc));
    expect(usdc).toBeGreaterThan(dexModule(thinPool).quote(thinPool, 'buy', SOL));

    const coins = 1_000n * 10n ** 6n;
    const sell = fundedBest([coinPool], legs, 'sell', coins);
    const back = dexModule(coinPool).quote(coinPool, 'sell', coins);
    expect(sell).toMatchObject({ route: coinPool, leg: legPool, mid: back });
    expect(sell?.out).toBe(dexModule(legPool).quote(legPool, 'sell', back));
    // Nothing to buy with: no quote at all.
    expect(fundedBest([coinPool], [], 'buy', SOL)).toBeNull();
  });
});

describe('Solana coins priced in a token, bought and sold with SOL', () => {
  const accounts: WalletAccount[] = [
    { id: 'a', name: 'A', hidden: false, primary: true, kind: 'derived', solana: WALLET },
  ];
  const tokenAccount = (mint: string, amount: bigint): AccountInfo => {
    const data = new Uint8Array(165);
    data.set(base58.decode(mint), 0);
    data.set(base58.decode(WALLET), 32);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    return { owner: TOKEN_PROGRAM, lamports: 2_039_280n, data, executable: false };
  };
  const balance = (mint: string, amount: bigint) => ({
    accountIndex: 1,
    mint,
    owner: WALLET,
    amount,
  });
  /** A confirmed transaction that moved `delta` of `mint` into the wallet, and `lamports`. */
  const landed = (mint: string, delta: bigint, lamports = 0n): TxMeta => ({
    err: null,
    fee: 5_000n,
    accountKeys: [WALLET],
    preBalances: [100n * SOL],
    postBalances: [100n * SOL + lamports - 5_000n],
    preTokenBalances: delta < 0n ? [balance(mint, -delta)] : [],
    postTokenBalances: delta > 0n ? [balance(mint, delta)] : [],
  });

  /**
   * SOL at $150 and the default limits; the coin trades on `coinPool` in USDC, and USDC on
   * `legPool` against SOL. Each transaction lands as `results` says, in the order signed.
   */
  async function setup(
    held: { coin?: bigint; usdc?: bigint },
    results: TxMeta[],
    /** The website's signer refuses each transaction with these decoded actions. */
    refuse?: BlockedAction[],
  ) {
    const settings = new SettingsStore(new MemoryStore());
    const tickets: TradeTicket[] = [];
    const signed: SolSignRequest[] = [];
    const metas = new Map<string, TxMeta>();
    const svc = new SolanaService({
      vault: { listAccounts: async () => accounts, isUnlocked: async () => true } as never,
      settings,
      local: new MemoryStore(),
      history: { list: async () => [] },
      notify: (t) => tickets.push(t),
      // The Nesty website's signer: each signature stands for one transaction, in order.
      sign: async (req) => {
        if (refuse)
          throw Object.assign(new Error(refuse.find((a) => !a.ok)?.reason ?? 'Blocked.'), {
            code: 'blocked',
            actions: refuse,
          });
        signed.push(req);
        const sig = new Uint8Array(64).fill(signed.length);
        const meta = results[signed.length - 1];
        if (meta) metas.set(base58.encode(sig), meta);
        return sig;
      },
      now: Date.now,
    });
    const coinAta = associatedTokenAddress(WALLET, COIN, TOKEN_PROGRAM);
    const usdcAta = associatedTokenAddress(WALLET, USDC_MINT, TOKEN_PROGRAM);
    svc.rpcFor = () =>
      ({
        getMultipleAccounts: async (keys: string[]) =>
          keys.map((k) =>
            k === WALLET
              ? { owner: SYSTEM_PROGRAM, lamports: 100n * SOL, data: new Uint8Array(0) }
              : k === coinAta && held.coin
                ? tokenAccount(COIN, held.coin)
                : k === usdcAta && held.usdc
                  ? tokenAccount(USDC_MINT, held.usdc)
                  : null,
          ),
        getBalance: async () => 100n * SOL,
        getLatestBlockhash: async () => ({
          blockhash: base58.encode(new Uint8Array(32).fill(5)),
          lastValidBlockHeight: 1_000_000,
        }),
        simulate: async () => ({ err: null, unitsConsumed: 100_000 }),
        broadcast: async () => 'sent',
        getSignatureStatuses: async (sigs: string[]) =>
          sigs.map((s) => {
            const m = metas.get(s);
            return m ? { confirmationStatus: 'confirmed', err: m.err } : null;
          }),
        getTransactionMeta: async (sig: string) => metas.get(sig) ?? null,
        getBlockHeight: async () => 1,
      }) as never;
    const meta = (mint: string) =>
      mint === COIN
        ? { name: 'Coin', symbol: 'COIN', decimals: 6, tokenProgram: TOKEN_PROGRAM, supply: 0n }
        : mint === USDC_MINT
          ? {
              name: 'USD Coin',
              symbol: 'USDC',
              decimals: 6,
              tokenProgram: TOKEN_PROGRAM,
              supply: 0n,
            }
          : null;
    Object.assign(svc, {
      price: { usd: async () => 150 },
      tokenMeta: async (m: string) => meta(m),
      market: async () => ({ routes: [coinPool], idle: null, funding: [legPool] }),
      fundingLegs: async () => [legPool],
    });
    /** The ticket once nothing in it is waiting any more. */
    const settled = async (id: string): Promise<TradeTicket> => {
      for (let i = 0; i < 100; i++) {
        const t = tickets.filter((x) => x.id === id).at(-1);
        const busy = t?.legs.some((l) => ['queued', 'sending', 'submitted'].includes(l.status));
        if (t && !busy && t.status !== 'working') {
          // Let the last balances read land too.
          await new Promise((r) => setTimeout(r, 50));
          return tickets.filter((x) => x.id === id).at(-1) as TradeTicket;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('never settled');
    };
    return { svc, signed, settled };
  }

  it("ends blocked, with Nesty's decoded actions, when the website's signer is refused", async () => {
    const actions = [
      { label: 'Swap on Raydium AMM', ok: true },
      { label: 'Transfer', ok: false, reason: 'Pays an address that is not yours' },
    ];
    const { svc, signed, settled } = await setup({ usdc: 14_900_000n }, [], actions);
    const start = await svc.buy({
      mint: COIN,
      amount: '0.1',
      walletIds: ['a'],
      mode: 'each',
      confirmed: false,
    });
    const t = await settled(start.id);
    expect(signed).toHaveLength(0);
    expect(t.status).toBe('blocked');
    expect(t.blocked).toEqual(actions);
    expect(t.legs.some((l) => l.status === 'blocked')).toBe(true);
  });

  it('quotes in SOL, through the token', async () => {
    const { svc } = await setup({ coin: 1_000n * 10n ** 6n }, []);
    const state = await svc.panelState(COIN);
    // Bought with SOL, as any other coin: no pay token, SOL balances and amounts.
    expect(state.pay).toBeUndefined();
    expect(state.nativeUsd).toBe(150);
    expect(state.wallets[0]?.native).toBe((100n * SOL).toString());

    const q = await svc.panelQuotes({ mint: COIN, buyAmounts: ['1'], sellBps: [10_000] });
    expect(q.buys[0]).toMatchObject({
      amountIn: SOL.toString(),
      amountOut: fundedBest([coinPool], [legPool], 'buy', SOL)?.out.toString(),
      venue: 'Raydium AMM via USDC',
    });
    expect(q.sells[0]?.amountOut).toBe(
      fundedBest([coinPool], [legPool], 'sell', 1_000n * 10n ** 6n)?.out.toString(),
    );
    // A coin is worth 0.01 USDC.
    expect(q.tokenUsd).toBeCloseTo(0.01, 6);
    expect(q.idle).toBeNull();
  });

  it('buys: SOL into the token, then the coin with exactly what arrived', async () => {
    const usdcIn = 14_900_000n;
    const coinsOut = 1_480_000_000n;
    const { svc, signed, settled } = await setup({ usdc: usdcIn }, [
      landed(USDC_MINT, usdcIn, -SOL / 10n),
      landed(COIN, coinsOut),
    ]);
    const start = await svc.buy({
      mint: COIN,
      amount: '0.1',
      walletIds: ['a'],
      mode: 'each',
      confirmed: false,
    });
    expect(start.pay).toBeUndefined();
    expect(start.route).toBe('Raydium AMM via USDC');
    expect(start.legs.map((l) => [l.kind, l.note ?? null, l.status])).toEqual([
      ['swap', null, 'queued'],
      ['step', 'SOL → USDC', 'queued'],
    ]);

    const t = await settled(start.id);
    expect(t.status).toBe('done');
    const [buy, step] = t.legs;
    expect(step).toMatchObject({ status: 'confirmed', amountIn: (SOL / 10n).toString() });
    expect(step?.amountOut).toBe(usdcIn.toString());
    expect(buy).toMatchObject({
      status: 'confirmed',
      amountIn: (SOL / 10n).toString(),
      amountOut: coinsOut.toString(),
    });

    // Two transactions, each checked again by the signer as the trade it is.
    expect(signed.map((s) => s.intent)).toEqual([
      { kind: 'trade', mint: USDC_MINT, side: 'buy', route: { kind: 'dex', pool: LEG_POOL } },
      { kind: 'trade', mint: COIN, side: 'buy', route: { kind: 'dex', pool: COIN_POOL } },
    ]);
    const amounts = (req: SolSignRequest | undefined) =>
      req?.instructions
        .map((ix) => dexModule(coinPool).amounts(ix.data))
        .find((a) => a !== null && a !== undefined);
    expect(amounts(signed[0])?.amountIn).toBe(SOL / 10n);
    // The coin's buy spends exactly the USDC the first step delivered.
    expect(amounts(signed[1])?.amountIn).toBe(usdcIn);
    expect(amounts(signed[1])?.minOut).toBe(
      ((bestRoute([coinPool], 'buy', usdcIn)?.out ?? 0n) * 9_000n) / 10_000n,
    );
  });

  it("buys with a website's own slippage, once its gate let the buy through", async () => {
    const usdcIn = 14_900_000n;
    const { svc, signed, settled } = await setup({ usdc: usdcIn }, [
      landed(USDC_MINT, usdcIn, -SOL / 10n),
      landed(COIN, 1_480_000_000n),
    ]);
    const gate = vi.fn(async () => false);
    const start = await svc.buy({
      mint: COIN,
      amount: '0.1',
      walletIds: ['a'],
      mode: 'each',
      confirmed: false,
      prefs: { solana: { slippageBps: 2000 } },
      gate,
    });
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ spend: '0.1 SOL', usd: expect.any(Number) }),
    );
    expect((await settled(start.id)).status).toBe('done');
    const minOut = signed[1]?.instructions
      .map((ix) => dexModule(coinPool).amounts(ix.data))
      .find((a) => a !== null && a !== undefined)?.minOut;
    expect(minOut).toBe(((bestRoute([coinPool], 'buy', usdcIn)?.out ?? 0n) * 8_000n) / 10_000n);
  });

  it('makes no buy its gate refused', async () => {
    const { svc, signed } = await setup({}, []);
    await expect(
      svc.buy({
        mint: COIN,
        amount: '0.1',
        walletIds: ['a'],
        mode: 'each',
        confirmed: false,
        gate: async () => {
          throw new Error('rejected');
        },
      }),
    ).rejects.toThrow('rejected');
    expect(signed).toHaveLength(0);
  });

  it('stops the buy when SOL does not become the token', async () => {
    const { svc, signed, settled } = await setup({}, [{ ...landed(USDC_MINT, 0n), err: 'x' }]);
    // The signer refuses nothing here, but the first transaction lands with an error.
    const start = await svc.buy({
      mint: COIN,
      amount: '0.1',
      walletIds: ['a'],
      mode: 'each',
      confirmed: false,
    });
    const t = await settled(start.id);
    expect(t.status).toBe('failed');
    expect(signed).toHaveLength(1);
    expect(t.legs[0]?.status).toBe('failed');
  });

  it('sells: the coin for the token, then exactly that back to SOL', async () => {
    const coins = 1_000n * 10n ** 6n;
    const usdcBack = 9_870_000n;
    const lamportsBack = 65_000_000n;
    const { svc, signed, settled } = await setup({ coin: coins }, [
      landed(USDC_MINT, usdcBack),
      landed(USDC_MINT, -usdcBack, lamportsBack),
    ]);
    const start = await svc.sell({ mint: COIN, bps: 10_000, walletIds: ['a'], confirmed: false });
    expect(start.pay).toBeUndefined();
    expect(start.legs.map((l) => [l.kind, l.note ?? null])).toEqual([
      ['swap', null],
      ['step', 'USDC → SOL'],
    ]);

    const t = await settled(start.id);
    expect(t.status).toBe('done');
    const [sell, step] = t.legs;
    expect(step).toMatchObject({ status: 'confirmed', amountIn: usdcBack.toString() });
    // What the sell got is the SOL its step brought back, not the USDC in between.
    expect(sell).toMatchObject({
      status: 'confirmed',
      amountIn: coins.toString(),
      amountOut: lamportsBack.toString(),
    });
    expect(signed.map((s) => s.intent)).toEqual([
      { kind: 'trade', mint: COIN, side: 'sell', route: { kind: 'dex', pool: COIN_POOL } },
      { kind: 'trade', mint: USDC_MINT, side: 'sell', route: { kind: 'dex', pool: LEG_POOL } },
    ]);
    const amounts = (req: SolSignRequest | undefined) =>
      req?.instructions
        .map((ix) => dexModule(legPool).amounts(ix.data))
        .find((a) => a !== null && a !== undefined);
    expect(amounts(signed[1])?.amountIn).toBe(usdcBack);
  });

  it('sells what the quotes just read, until a transaction from the wallet moves it', async () => {
    const held = { coin: 1_000n * 10n ** 6n };
    const usdcBack = 9_870_000n;
    const { svc, settled } = await setup(held, [
      landed(USDC_MINT, usdcBack),
      landed(USDC_MINT, -usdcBack, 65_000_000n),
      landed(USDC_MINT, usdcBack),
      landed(USDC_MINT, -usdcBack, 65_000_000n),
    ]);
    await svc.panelQuotes({ mint: COIN, buyAmounts: ['1'], sellBps: [10_000] });
    // The chain moves after the quotes read it: the click takes their read, and reads nothing.
    held.coin = 400n * 10n ** 6n;
    const first = await svc.sell({ mint: COIN, bps: 10_000, walletIds: ['a'], confirmed: false });
    expect(first.legs[0]?.amountIn).toBe((1_000n * 10n ** 6n).toString());
    await settled(first.id);

    // That sell went out and landed: what was read before it no longer counts.
    const second = await svc.sell({ mint: COIN, bps: 10_000, walletIds: ['a'], confirmed: false });
    expect(second.legs[0]?.amountIn).toBe((400n * 10n ** 6n).toString());
    await settled(second.id);
  });
});
