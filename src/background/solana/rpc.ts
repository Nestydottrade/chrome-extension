import { fromBase64, toBase64 } from '../../shared/base64';
import type { SolAddress } from '../../shared/solana';

export interface AccountInfo {
  owner: SolAddress;
  lamports: bigint;
  data: Uint8Array;
  executable: boolean;
}

export interface SignatureStatus {
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  err: unknown;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
}

/** Balances around a confirmed transaction, for what a trade really paid and received. */
export interface TxMeta {
  err: unknown;
  fee: bigint;
  accountKeys: SolAddress[];
  preBalances: bigint[];
  postBalances: bigint[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

export interface TokenBalance {
  accountIndex: number;
  mint: SolAddress;
  owner: SolAddress | null;
  amount: bigint;
}

/** A JSON-RPC error from the node itself (not the transport). */
export class SolRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 8_000;
/** Node errors that another endpoint may not have: unhealthy node, rate limit. */
const RETRY_CODES = new Set([-32005, -32007, -32016, 429]);

/** How many keys a node says one getMultipleAccounts may name, from its refusal; else null. */
export function keysLimit(message: string): number | null {
  const n = Number(/maximum of (\d+) accounts/i.exec(message)?.[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The node's own refusal behind an HTTP error, when it is one about request size: public
 * endpoints answer "A maximum of 10 accounts is allowed" with a 403.
 */
async function sizeRefusal(res: Response): Promise<SolRpcError | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const { code, message } = body.error ?? {};
    return typeof code === 'number' && typeof message === 'string' && keysLimit(message) !== null
      ? new SolRpcError(code, message)
      : null;
  } catch {
    return null;
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Solana JSON-RPC over HTTPS. Endpoints are tried in order; a transport failure, an HTTP
 * error or an unhealthy node moves on to the next one. An answer from the node (such as
 * a failed simulation) is final.
 */
export class SolRpc {
  private next = 1;
  /** Keys per getMultipleAccounts: 100 by the spec, fewer once an endpoint refuses more. */
  private keysPerCall = 100;

  constructor(
    readonly urls: readonly string[],
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {
    if (urls.length === 0) throw new Error('no rpc');
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown = new Error('rpc');
    for (const url of this.urls) {
      try {
        return await this.once<T>(url, method, params);
      } catch (e) {
        if (e instanceof SolRpcError && !RETRY_CODES.has(e.code)) throw e;
        last = e;
      }
    }
    throw last;
  }

  /** Sends to every endpoint at once; resolves with the first that accepts. */
  async broadcast(raw: Uint8Array): Promise<string> {
    const b64 = toBase64(raw);
    const params = [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }];
    return Promise.any(this.urls.map((u) => this.once<string>(u, 'sendTransaction', params)));
  }

  private async once<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.next++, method, params }),
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok)
        throw (
          (await sizeRefusal(res)) ??
          new SolRpcError(res.status === 429 ? 429 : -32005, `HTTP ${res.status}`)
        );
      const body = (await res.json()) as {
        result?: T;
        error?: { code: number; message: string; data?: unknown };
      };
      if (body.error) throw new SolRpcError(body.error.code, body.error.message, body.error.data);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── typed methods ─────────────────────────────────────────────────────────

  async getMultipleAccounts(keys: readonly SolAddress[]): Promise<(AccountInfo | null)[]> {
    if (keys.length === 0) return [];
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < keys.length;) {
      const size = this.keysPerCall;
      try {
        const r = await this.call<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [
          keys.slice(i, i + size),
          { encoding: 'base64', commitment: 'confirmed' },
        ]);
        out.push(...r.value.map(parseAccount));
        i += size;
      } catch (e) {
        // An endpoint that takes fewer keys says how many: kept for later reads, and this
        // part is read again in smaller pieces.
        const limit = e instanceof SolRpcError ? keysLimit(e.message) : null;
        if (limit === null || limit >= size) throw e;
        this.keysPerCall = limit;
      }
    }
    return out;
  }

  async getAccount(key: SolAddress): Promise<AccountInfo | null> {
    return (await this.getMultipleAccounts([key]))[0] ?? null;
  }

  async getBalance(key: SolAddress): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [key, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  /** The least an account of `size` bytes may hold, other than nothing: its rent exemption. */
  async minimumBalance(size: number): Promise<bigint> {
    const r = await this.call<number>('getMinimumBalanceForRentExemption', [
      size,
      { commitment: 'confirmed' },
    ]);
    return BigInt(r);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
    );
    return r.value;
  }

  async getBlockHeight(): Promise<number> {
    return this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
  }

  /** Runs an unsigned transaction against the current state (signatures not checked). */
  async simulate(raw: Uint8Array): Promise<SimulationResult> {
    const r = await this.call<{
      value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
    }>('simulateTransaction', [
      toBase64(raw),
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      },
    ]);
    return {
      err: r.value.err,
      logs: r.value.logs ?? [],
      unitsConsumed: r.value.unitsConsumed ?? null,
    };
  }

  async getSignatureStatuses(sigs: readonly string[]): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [
      sigs,
      { searchTransactionHistory: false },
    ]);
    return r.value;
  }

  /** A landed transaction's balances. Ours are legacy; others may be v0 or v1. */
  async getTransactionMeta(sig: string, maxVersion = 0): Promise<TxMeta | null> {
    const r = await this.call<RawTx | null>('getTransaction', [
      sig,
      { encoding: 'json', maxSupportedTransactionVersion: maxVersion, commitment: 'confirmed' },
    ]);
    if (!r?.meta) return null;
    const m = r.meta;
    const tokens = (list: RawTokenBalance[] | undefined) =>
      (list ?? []).map((b) => ({
        accountIndex: b.accountIndex,
        mint: b.mint,
        owner: b.owner ?? null,
        amount: BigInt(b.uiTokenAmount.amount),
      }));
    return {
      err: m.err,
      fee: BigInt(m.fee),
      accountKeys: [
        ...r.transaction.message.accountKeys,
        ...(m.loadedAddresses?.writable ?? []),
        ...(m.loadedAddresses?.readonly ?? []),
      ],
      preBalances: m.preBalances.map(BigInt),
      postBalances: m.postBalances.map(BigInt),
      preTokenBalances: tokens(m.preTokenBalances),
      postTokenBalances: tokens(m.postTokenBalances),
    };
  }

  /** The latest transaction signatures that touched `address`, newest first. */
  async getSignatures(address: SolAddress, limit: number): Promise<string[]> {
    const r = await this.call<{ signature: string }[]>('getSignaturesForAddress', [
      address,
      { limit, commitment: 'confirmed' },
    ]);
    return r.map((s) => s.signature);
  }

  /**
   * Every token account `owner` has under `program`, raw (165+ bytes each). An indexed
   * read: public endpoints refuse it, so only a user's own RPC answers.
   */
  async getTokenAccounts(
    owner: SolAddress,
    program: SolAddress,
  ): Promise<{ address: SolAddress; data: Uint8Array }[]> {
    const r = await this.call<{ value: { pubkey: string; account: RawAccount }[] }>(
      'getTokenAccountsByOwner',
      [owner, { programId: program }, { encoding: 'base64', commitment: 'confirmed' }],
    );
    return r.value.map((v) => ({ address: v.pubkey, data: fromBase64(v.account.data[0]) }));
  }
}

interface RawAccount {
  owner: string;
  lamports: number;
  data: [string, string];
  executable: boolean;
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface RawTx {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

function parseAccount(a: RawAccount | null): AccountInfo | null {
  if (!a) return null;
  return {
    owner: a.owner,
    lamports: BigInt(a.lamports),
    data: fromBase64(a.data[0]),
    executable: a.executable,
  };
}
