import { toBase64 } from '../../shared/base64';
import { SOLANA, type SolAddress } from '../../shared/solana';
import type { TxMeta } from './rpc';
import { transfer } from './spl';
import type { Instruction } from './tx';

/**
 * MEV protection on Solana. A trade goes out through Jito's block engines as a bundle of its
 * own (sendTransaction with bundleOnly), never to a public RPC: it lands whole or not at all,
 * so one that would fail costs nothing. It tips the engine, to one of its tip accounts, and
 * carries a marker that makes the engine refuse any bundle that puts another transaction
 * before it, as a sandwich would. A validator that runs its own queue is out of the marker's
 * reach. The Android app sends its trades the same way (sol/Jito.kt).
 */

/** The block engine's tip accounts (getTipAccounts, the same in every region). */
export const TIP_ACCOUNTS: readonly SolAddress[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** The engine's marker: any key starting "jitodontfront", read-only. */
export const DONT_FRONT: SolAddress = 'jitodontfront111111111111111111111111111111';

/** A tip of `lamports` from `wallet` to `account`, one of TIP_ACCOUNTS; with the marker when `marked`. */
export function tipInstruction(
  wallet: SolAddress,
  lamports: bigint,
  account: SolAddress,
  marked: boolean,
): Instruction {
  const ix = transfer(wallet, account, lamports);
  return marked
    ? { ...ix, keys: [...ix.keys, { pubkey: DONT_FRONT, isSigner: false, isWritable: false }] }
    : ix;
}

/** A tip account picked at random: tips spread over all of them, as the engine asks. */
export function anyTipAccount(): SolAddress {
  return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)] as SolAddress;
}

/** What a confirmed transaction tipped the block engine, from its balances. */
export function tipPaid(meta: TxMeta): bigint {
  let paid = 0n;
  meta.accountKeys.forEach((key, i) => {
    if (TIP_ACCOUNTS.includes(key))
      paid += (meta.postBalances[i] ?? 0n) - (meta.preBalances[i] ?? 0n);
  });
  return paid > 0n ? paid : 0n;
}

/** Sends a signed trade privately. */
export interface PrivateSender {
  /** Resolves with the signature once a block engine took the transaction. */
  send(raw: Uint8Array): Promise<string>;
  /** Sends it again to one engine that is free right now, if any; never waits. */
  resend(raw: Uint8Array): void;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const SEND_PATH = '/api/v1/transactions?bundleOnly=true';
/**
 * Each engine takes about a request a second from one address (Jito's default limit;
 * measured 2026-11-16, a third request within a second was refused with a 429).
 */
const ENGINE_GAP_MS = 1_050;
/** Engines one send goes to: three wallets of one click go out at once. */
const ENGINES_PER_SEND = 3;
/** The longest a send waits for an engine to be free. */
const MAX_WAIT_MS = 5_000;
const TIMEOUT_MS = 8_000;
const BUSY = 'The private route is busy. Try again in a moment.';

/**
 * The block engines, spaced to their limit: a send goes to up to three engines free now (the
 * nearest region first, then the others in turn), and waits for one when none is.
 */
export class BlockEngines implements PrivateSender {
  private readonly freeAt: number[];
  /** Where the next pick starts among the regions after the nearest. */
  private turn = 0;
  private id = 1;

  constructor(
    private readonly urls: readonly string[] = SOLANA.blockEngines,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (urls.length === 0) throw new Error('no block engine');
    this.freeAt = urls.map(() => 0);
  }

  async send(raw: Uint8Array): Promise<string> {
    const body = this.body(raw);
    const start = this.now();
    let picked = this.pick(ENGINES_PER_SEND);
    while (picked.length === 0) {
      if (this.now() - start >= MAX_WAIT_MS) throw new Error(BUSY);
      await this.wait(Math.max(1, Math.min(...this.freeAt) - this.now()));
      picked = this.pick(ENGINES_PER_SEND);
    }
    try {
      return await Promise.any(picked.map((i) => this.post(i, body)));
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      const said = errors.map((x) => (x instanceof Error ? x.message : String(x)));
      const own = said.find((m) => m !== 'busy');
      throw new Error(own ? `The private route did not take it: ${own}` : BUSY, { cause: e });
    }
  }

  resend(raw: Uint8Array): void {
    const [i] = this.pick(1);
    if (i !== undefined) void this.post(i, this.body(raw)).catch(() => undefined);
  }

  /** Up to `n` engines free now, the nearest first, then the regions in turn; held for the gap. */
  private pick(n: number): number[] {
    const now = this.now();
    const rest = this.urls.length - 1;
    const order = [0];
    for (let k = 0; k < rest; k++) order.push(1 + ((this.turn + k) % rest));
    const out = order.filter((i) => (this.freeAt[i] ?? 0) <= now).slice(0, n);
    for (const i of out) this.freeAt[i] = now + ENGINE_GAP_MS;
    if (rest > 0) this.turn = (this.turn + out.filter((i) => i !== 0).length) % rest;
    return out;
  }

  private body(raw: Uint8Array): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: this.id++,
      method: 'sendTransaction',
      params: [toBase64(raw), { encoding: 'base64' }],
    });
  }

  private async post(i: number, body: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.urls[i]}${SEND_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.status === 429) {
        // Over the limit for this address: left alone a while longer.
        this.freeAt[i] = this.now() + 2 * ENGINE_GAP_MS;
        throw new Error('busy');
      }
      const r = (await res.json().catch(() => null)) as {
        result?: unknown;
        error?: { message?: unknown };
      } | null;
      if (r?.error)
        throw new Error(
          typeof r.error.message === 'string' ? r.error.message.slice(0, 160) : 'refused',
        );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (typeof r?.result !== 'string') throw new Error('no answer');
      return r.result;
    } finally {
      clearTimeout(timer);
    }
  }
}
