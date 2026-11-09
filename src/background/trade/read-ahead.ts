/**
 * What a sell reads at the click, read ahead with the panel's quotes: each wallet's balance of
 * the token, its allowance for the route's spender and, where the venue sells through Permit2,
 * its Permit2 allowance. A sell clicked moments later takes them from here and skips those
 * round trips (about half a second on Robinhood).
 *
 * A value counts only while fresh, and only when nothing sent from that wallet went out or
 * landed since its read was sent. The engines also pass over it while a transaction from the
 * wallet is still out (their `ahead`), since its balance may change any moment.
 */
export const READ_AHEAD_FRESH_MS = 4_000;

/** Above this many values, the stale ones are dropped. */
const PRUNE_AT = 400;

export interface Permit2Allowance {
  amount: bigint;
  expiration: number;
  nonce: number;
}

/** An EVM address is one key in any case; a base58 one (Solana) keeps its case. */
const norm = (a: string) => (a.startsWith('0x') ? a.toLowerCase() : a);

export class ReadAhead {
  private readonly values = new Map<string, { at: number; value: bigint | Permit2Allowance }>();
  /** When something sent from a wallet last went out or landed, by chain and wallet. */
  private readonly moves = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly freshMs = READ_AHEAD_FRESH_MS,
  ) {}

  /** `at`: when the read was sent, so a transaction that moved the wallet meanwhile voids it. */
  noteBalance(chainId: number, token: string, wallet: string, amount: bigint, at: number): void {
    this.put(chainId, wallet, `b:${norm(token)}`, amount, at);
  }

  noteAllowance(
    chainId: number,
    token: string,
    wallet: string,
    spender: string,
    amount: bigint,
    at: number,
  ): void {
    this.put(chainId, wallet, `a:${norm(token)}:${norm(spender)}`, amount, at);
  }

  notePermit2(
    chainId: number,
    token: string,
    wallet: string,
    spender: string,
    value: Permit2Allowance,
    at: number,
  ): void {
    this.put(chainId, wallet, `p:${norm(token)}:${norm(spender)}`, value, at);
  }

  balance(chainId: number, token: string, wallet: string): bigint | undefined {
    const v = this.get(chainId, wallet, `b:${norm(token)}`);
    return typeof v === 'bigint' ? v : undefined;
  }

  allowance(chainId: number, token: string, wallet: string, spender: string): bigint | undefined {
    const v = this.get(chainId, wallet, `a:${norm(token)}:${norm(spender)}`);
    return typeof v === 'bigint' ? v : undefined;
  }

  permit2(
    chainId: number,
    token: string,
    wallet: string,
    spender: string,
  ): Permit2Allowance | undefined {
    const v = this.get(chainId, wallet, `p:${norm(token)}:${norm(spender)}`);
    return v === undefined || typeof v === 'bigint' ? undefined : v;
  }

  /** A transaction from `wallet` went out or landed: what was read of it before is void. */
  moved(chainId: number, wallet: string): void {
    this.moves.set(`${chainId}:${norm(wallet)}`, this.now());
  }

  private put(
    chainId: number,
    wallet: string,
    what: string,
    value: bigint | Permit2Allowance,
    at: number,
  ): void {
    if (this.values.size >= PRUNE_AT) this.prune();
    this.values.set(`${chainId}:${norm(wallet)}:${what}`, { at, value });
  }

  private get(
    chainId: number,
    wallet: string,
    what: string,
  ): bigint | Permit2Allowance | undefined {
    const hit = this.values.get(`${chainId}:${norm(wallet)}:${what}`);
    if (!hit || this.now() - hit.at > this.freshMs) return undefined;
    const moved = this.moves.get(`${chainId}:${norm(wallet)}`);
    return moved !== undefined && moved >= hit.at ? undefined : hit.value;
  }

  /** Drops what can no longer count: a move older than the window voids only stale values. */
  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.values) if (now - v.at > this.freshMs) this.values.delete(k);
    for (const [k, at] of this.moves) if (now - at > this.freshMs) this.moves.delete(k);
  }
}
