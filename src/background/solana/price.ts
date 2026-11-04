import { USDC_MINT, WSOL_MINT, toAddress } from './address';
import { Reader } from './layouts';
import type { AccountInfo, SolRpc } from './rpc';

/** Orca's SOL/USDC Whirlpool: the deepest SOL/USD pool on chain. */
export const SOL_USD_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const TTL_MS = 20_000;

/**
 * SOL in USD from the pool's sqrt price (Q64.64, USDC per SOL before decimals). Null for
 * anything that is not that pool, or a price no market would show.
 */
export function solUsdFromWhirlpool(account: AccountInfo | null): number | null {
  if (!account || account.owner !== WHIRLPOOL_PROGRAM || account.data.length < 213) return null;
  const d = account.data;
  if (toAddress(d.subarray(101, 133)) !== WSOL_MINT) return null;
  if (toAddress(d.subarray(181, 213)) !== USDC_MINT) return null;
  const sqrt = Number(new Reader(d, 65).u128()) / 2 ** 64;
  // SOL has 9 decimals, USDC 6.
  const usd = sqrt * sqrt * 1e3;
  return Number.isFinite(usd) && usd > 0.01 && usd < 1_000_000 ? usd : null;
}

/** SOL/USD for the USD limits and values, cached briefly; null when unavailable. */
export class SolPrice {
  private cached: { usd: number; at: number } | null = null;
  private inflight: Promise<number | null> | null = null;

  constructor(
    private readonly rpc: () => Promise<SolRpc>,
    private readonly now: () => number = Date.now,
  ) {}

  async usd(): Promise<number | null> {
    if (this.cached && this.now() - this.cached.at < TTL_MS) return this.cached.usd;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<number | null> {
    try {
      const usd = solUsdFromWhirlpool(await (await this.rpc()).getAccount(SOL_USD_POOL));
      if (usd !== null) this.cached = { usd, at: this.now() };
      return usd ?? this.cached?.usd ?? null;
    } catch {
      return this.cached?.usd ?? null;
    }
  }
}
