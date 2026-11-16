import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  findProgramAddress,
  seed,
} from '../src/background/solana/address';
import type { RaydiumAmmVenue } from '../src/background/solana/dex/raydium-amm';
import {
  BlockEngines,
  DONT_FRONT,
  TIP_ACCOUNTS,
  tipInstruction,
  tipPaid,
} from '../src/background/solana/jito';
import { SOL_QUOTE } from '../src/background/solana/pump';
import { tradeBuilder, tradeDelivered, validateTrade } from '../src/background/solana/routes';
import type { TxMeta } from '../src/background/solana/rpc';
import { SolanaService, type SolSignRequest } from '../src/background/solana/service';
import { setComputeUnitLimit, setComputeUnitPrice, transfer } from '../src/background/solana/spl';
import type { Instruction } from '../src/background/solana/tx';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { TradeTicket } from '../src/shared/panel';
import { DEFAULT_SOLANA_SETTINGS, solanaTip } from '../src/shared/settings/defaults';
import { MIN_TIP_LAMPORTS, tipLamports } from '../src/shared/solana';
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
const WALLET = address('nesty-mev-wallet');
const COIN = address('nesty-mev-coin');
const COIN_POOL = address('nesty-mev-pool');
const STRANGER = address('nesty-mev-stranger');
const SOL = 1_000_000_000n;
const TIP_TO = TIP_ACCOUNTS[0] as string;

/** The coin on a Raydium AMM pool against SOL: 1,000,000 coins against 1,000 SOL. */
const solPool: RaydiumAmmVenue = {
  kind: 'dex',
  dex: 'raydium-amm',
  pool: COIN_POOL,
  mint: COIN,
  tokenProgram: TOKEN_PROGRAM,
  quote: SOL_QUOTE,
  coinIsMint: true,
  status: 1n,
  openTime: 0n,
  feeNumerator: 25n,
  feeDenominator: 10_000n,
  coinVault: address('nesty-mev-coin-vault'),
  pcVault: address('nesty-mev-quote-vault'),
  coinReserve: 1_000_000n * 10n ** 6n,
  pcReserve: 1_000n * SOL,
};

/** The lamports a system transfer moves. */
const lamportsOf = (ix: Instruction) =>
  new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true);
const isTip = (ix: Instruction) =>
  ix.programId === SYSTEM_PROGRAM && TIP_ACCOUNTS.includes(ix.keys[1]?.pubkey ?? '');

describe('MEV protection tip', () => {
  it('is a tenth of the priority fee, and at least the block engine minimum', () => {
    expect(tipLamports(100_000n)).toBe(10_000n);
    expect(tipLamports(500_000n)).toBe(50_000n);
    expect(tipLamports(2_000_000n)).toBe(200_000n);
    expect(tipLamports(5_000n)).toBe(MIN_TIP_LAMPORTS);
    // On by default, at Medium: 0.0005 SOL priority, 0.00005 SOL tip.
    expect(DEFAULT_SOLANA_SETTINGS.mevEnabled).toBe(true);
    expect(solanaTip(DEFAULT_SOLANA_SETTINGS)).toBe('0.00005');
    expect(solanaTip({ ...DEFAULT_SOLANA_SETTINGS, priority: 'high' })).toBe('0.0002');
  });

  it('is counted out of what a sell paid, as the network fee is', () => {
    const fee = 505_000n;
    const tip = 50_000n;
    const meta: TxMeta = {
      err: null,
      fee,
      accountKeys: [WALLET, TIP_ACCOUNTS[3] as string],
      preBalances: [10n * SOL, SOL],
      postBalances: [10n * SOL + 65_000_000n - fee - tip, SOL + tip],
      preTokenBalances: [],
      postTokenBalances: [],
    };
    expect(tipPaid(meta)).toBe(tip);
    expect(tradeDelivered(meta, WALLET, 'sell', COIN, SOL_QUOTE)).toBe(65_000_000n);
  });
});

describe('Solana validator with MEV protection', () => {
  const buy = tradeBuilder(solPool)?.('buy', WALLET, SOL / 10n, 1n);
  if (!buy) throw new Error('no trade');
  // 500,000 lamports of priority fee: 2,500,000 micro-lamports per unit over 200,000 units.
  const budget = [setComputeUnitLimit(200_000), setComputeUnitPrice(2_500_000n)];
  const noTip = {
    wallet: WALLET,
    mint: COIN,
    route: solPool,
    side: 'buy' as const,
    maxSpend: SOL,
    maxPriorityLamports: 10_000_000n,
  };
  const ctx = { ...noTip, maxTipLamports: 50_000n };
  const check = (extra: Instruction[], over: Partial<typeof ctx> = {}) =>
    validateTrade([...budget, ...buy.instructions, ...extra], { ...ctx, ...over });
  const refusal = (r: ReturnType<typeof check>) => r.actions.find((a) => !a.ok)?.reason;

  it('takes one tip to a tip account, with or without the marker', () => {
    for (const marked of [false, true]) {
      const r = check([tipInstruction(WALLET, 50_000n, TIP_TO, marked)]);
      expect(r.ok).toBe(true);
      expect(r.actions).toContainEqual({ label: 'MEV protection tip 0.00005 SOL', ok: true });
    }
    expect(check([tipInstruction(WALLET, 10_000n, TIP_TO, true)]).ok).toBe(true);
  });

  it('refuses a tip while MEV protection is off, or one above the settings', () => {
    const tip = tipInstruction(WALLET, 50_000n, TIP_TO, true);
    expect(refusal(check([tip], { maxTipLamports: 0n }))).toBe('MEV protection is off');
    expect(validateTrade([...budget, ...buy.instructions, tip], noTip).ok).toBe(false);
    expect(refusal(check([tipInstruction(WALLET, 60_000n, TIP_TO, true)]))).toBe(
      'Above your MEV protection tip',
    );
    expect(refusal(check([tipInstruction(WALLET, 999n, TIP_TO, true)]))).toBe(
      "Below the block engine's minimum",
    );
  });

  it('refuses a second tip, and any transfer to another address', () => {
    const tip = tipInstruction(WALLET, 20_000n, TIP_TO, false);
    expect(refusal(check([tip, tip]))).toBe('Only one tip');
    expect(refusal(check([transfer(WALLET, STRANGER, 50_000n)]))).toBe(
      'Only one transfer to your own wrapped SOL',
    );
    // A tip account named, but with an account of its own added: not a tip Nesty builds.
    const odd = tipInstruction(WALLET, 50_000n, TIP_TO, false);
    odd.keys.push({ pubkey: STRANGER, isSigner: false, isWritable: true });
    expect(check([odd]).ok).toBe(false);
  });

  it('holds the priority fee and the tip together to the max network fee', () => {
    const tip = tipInstruction(WALLET, 50_000n, TIP_TO, true);
    expect(check([tip], { maxPriorityLamports: 540_000n }).ok).toBe(false);
    expect(refusal(check([tip], { maxPriorityLamports: 540_000n }))).toBe(
      'Above your max network fee, with the tip',
    );
    expect(check([tip], { maxPriorityLamports: 550_000n }).ok).toBe(true);
  });
});

describe('Block engines', () => {
  const urls = Array.from({ length: 9 }, (_, i) => `https://e${i}`);
  const sendPath = '/api/v1/transactions?bundleOnly=true';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function engines(answer: (url: string) => Response) {
    const calls: { url: string; body: string }[] = [];
    const waits: number[] = [];
    let now = 1_000;
    const e = new BlockEngines(
      urls,
      async (url, init) => {
        calls.push({ url, body: String(init.body) });
        return answer(url);
      },
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    return { e, calls, waits };
  }
  const raw = Uint8Array.of(1, 2, 3);

  it('sends to three engines, the nearest first, and takes the first answer', async () => {
    const { e, calls } = engines(() => json({ jsonrpc: '2.0', id: 1, result: 'SIG' }));
    expect(await e.send(raw)).toBe('SIG');
    expect(calls.map((c) => c.url)).toEqual(urls.slice(0, 3).map((u) => `${u}${sendPath}`));
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.method).toBe('sendTransaction');
    expect(body.params).toEqual(['AQID', { encoding: 'base64' }]);
  });

  it('spreads a burst over the engines, then waits for one to be free', async () => {
    const { e, calls, waits } = engines(() => json({ result: 'SIG' }));
    for (let i = 0; i < 3; i++) await e.send(raw);
    // Three wallets of one click: every engine once, none twice within its second.
    expect(new Set(calls.map((c) => c.url)).size).toBe(9);
    expect(waits).toEqual([]);
    await e.send(raw);
    expect(waits).toEqual([1_050]);
    expect(calls).toHaveLength(12);
  });

  it("fails with the engine's reason when none takes it, and never sends elsewhere", async () => {
    const { e, calls } = engines(() =>
      json({ error: { code: -32602, message: 'bundle must tip at least 1000 lamports' } }),
    );
    await expect(e.send(raw)).rejects.toThrow(
      'The private route did not take it: bundle must tip at least 1000 lamports',
    );
    expect(calls.every((c) => urls.some((u) => c.url.startsWith(u)))).toBe(true);
  });

  it('says it is busy when every engine it tried is over its limit', async () => {
    const { e } = engines(() => new Response('', { status: 429 }));
    await expect(e.send(raw)).rejects.toThrow('The private route is busy. Try again in a moment.');
  });

  it('re-sends to one free engine, and never waits for one', async () => {
    const { e, calls, waits } = engines(() => json({ result: 'SIG' }));
    await e.send(raw);
    e.resend(raw);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.url).toBe(`https://e3${sendPath}`);
    // Every engine busy: nothing goes, nothing waits.
    await e.send(raw);
    await e.send(raw);
    const before = calls.length;
    e.resend(raw);
    expect(calls).toHaveLength(before);
    expect(waits).toEqual([]);
  });
});

describe('Solana trades with MEV protection', () => {
  const accounts: WalletAccount[] = [
    { id: 'a', name: 'A', hidden: false, primary: true, kind: 'derived', solana: WALLET },
  ];

  /** SOL at $150 and the default limits; every transaction lands, paying its tip. */
  async function setup(opts: { engines?: boolean; mev?: boolean; refuse?: boolean } = {}) {
    const settings = new SettingsStore(new MemoryStore());
    if (opts.mev === false) await settings.updateSolana({ mevEnabled: false });
    const tickets: TradeTicket[] = [];
    const signed: SolSignRequest[] = [];
    const metas = new Map<string, TxMeta>();
    const engines = {
      send: vi.fn(async () => {
        if (opts.refuse) throw new Error('The private route is busy. Try again in a moment.');
        return 'sig';
      }),
      resend: vi.fn(),
    };
    const svc = new SolanaService({
      vault: { listAccounts: async () => accounts, isUnlocked: async () => true } as never,
      settings,
      local: new MemoryStore(),
      history: { list: async () => [] },
      notify: (t) => tickets.push(t),
      sign: async (req) => {
        signed.push(req);
        const sig = new Uint8Array(64).fill(signed.length);
        const tip = req.instructions.find(isTip);
        const tipTo = tip?.keys[1]?.pubkey;
        const paid = tip ? lamportsOf(tip) : 0n;
        metas.set(base58.encode(sig), {
          err: null,
          fee: 505_000n,
          accountKeys: [WALLET, address('nesty-mev-coin-ata'), ...(tipTo ? [tipTo] : [])],
          preBalances: [100n * SOL, 0n, ...(tipTo ? [SOL] : [])],
          postBalances: [100n * SOL - SOL / 10n - 505_000n - paid, 0n, ...(tipTo ? [SOL + paid] : [])],
          preTokenBalances: [],
          postTokenBalances: [{ accountIndex: 1, mint: COIN, owner: WALLET, amount: 99_000_000n }],
        });
        return sig;
      },
      ...(opts.engines !== false && { engines }),
      now: Date.now,
    });
    const broadcast = vi.fn(async () => 'sent');
    svc.rpcFor = () =>
      ({
        getMultipleAccounts: async (keys: string[]) =>
          keys.map((k) =>
            k === WALLET
              ? { owner: SYSTEM_PROGRAM, lamports: 100n * SOL, data: new Uint8Array(0) }
              : null,
          ),
        getBalance: async () => 100n * SOL,
        getLatestBlockhash: async () => ({
          blockhash: base58.encode(new Uint8Array(32).fill(5)),
          lastValidBlockHeight: 1_000_000,
        }),
        simulate: async () => ({ err: null, unitsConsumed: 100_000 }),
        broadcast,
        getSignatureStatuses: async (sigs: string[]) =>
          sigs.map((s) => (metas.has(s) ? { confirmationStatus: 'confirmed', err: null } : null)),
        getTransactionMeta: async (sig: string) => metas.get(sig) ?? null,
        getBlockHeight: async () => 1,
      }) as never;
    Object.assign(svc, {
      price: { usd: async () => 150 },
      tokenMeta: async (m: string) =>
        m === COIN
          ? { name: 'Coin', symbol: 'COIN', decimals: 6, tokenProgram: TOKEN_PROGRAM, supply: 0n }
          : null,
      market: async () => ({ routes: [solPool], idle: null }),
    });
    const settled = async (id: string): Promise<TradeTicket> => {
      for (let i = 0; i < 100; i++) {
        const t = tickets.filter((x) => x.id === id).at(-1);
        const busy = t?.legs.some((l) => ['queued', 'sending', 'submitted'].includes(l.status));
        if (t && !busy && t.status !== 'working') {
          await new Promise((r) => setTimeout(r, 50));
          return tickets.filter((x) => x.id === id).at(-1) as TradeTicket;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('never settled');
    };
    const buy = () =>
      svc.buy({ mint: COIN, amount: '0.1', walletIds: ['a'], mode: 'each', confirmed: false });
    return { svc, signed, engines, broadcast, settled, buy };
  }

  it('shows the panel that trades go privately, and the tip they add', async () => {
    const { svc } = await setup();
    expect((await svc.panelState(COIN)).chain.mev).toEqual({
      supported: true,
      enabled: true,
      configured: true,
      tip: '0.00005',
    });
    const plain = await setup({ engines: false });
    expect((await plain.svc.panelState(COIN)).chain.mev.supported).toBe(false);
  });

  it('buys privately: one tip with the marker, to the block engines alone', async () => {
    const { signed, engines, broadcast, settled, buy } = await setup();
    const t = await settled((await buy()).id);
    expect(t.status).toBe('done');
    expect(t.settings?.mev).toBe(true);
    const tips = signed[0]?.instructions.filter(isTip) ?? [];
    expect(tips).toHaveLength(1);
    const [tip] = tips;
    // The last instruction: 0.00005 SOL at Medium, and the marker against sandwiches.
    expect(signed[0]?.instructions.at(-1)).toBe(tip);
    expect(tip && lamportsOf(tip)).toBe(50_000n);
    expect(tip?.keys.map((k) => k.pubkey).slice(0, 1)).toEqual([WALLET]);
    expect(tip?.keys[2]).toEqual({ pubkey: DONT_FRONT, isSigner: false, isWritable: false });
    expect(engines.send).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
    expect(t.legs[0]).toMatchObject({ status: 'confirmed', tipLamports: '50000' });
  });

  it('never falls back to a public RPC when no engine takes it', async () => {
    const { engines, broadcast, settled, buy } = await setup({ refuse: true });
    const t = await settled((await buy()).id);
    expect(t.legs[0]?.status).toBe('failed');
    expect(t.legs[0]?.error).toContain('private route is busy');
    expect(engines.send).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sends as before with MEV protection off, or where it is not offered', async () => {
    for (const opts of [{ mev: false }, { engines: false }]) {
      const { signed, engines, broadcast, settled, buy } = await setup(opts);
      const t = await settled((await buy()).id);
      expect(t.status).toBe('done');
      expect(t.settings?.mev).toBe(opts.mev === false ? false : undefined);
      expect(signed[0]?.instructions.some(isTip)).toBe(false);
      expect(broadcast).toHaveBeenCalled();
      expect(engines.send).not.toHaveBeenCalled();
      expect(t.legs[0]?.tipLamports).toBeUndefined();
    }
  });
});
