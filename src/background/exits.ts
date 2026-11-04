import { getAddress, isAddressEqual, type Address } from 'viem';
import {
  EXIT_TRIES,
  MAX_EXIT_PLANS,
  coveredCost,
  dueRule,
  mergeRules,
  multipleBps,
  type ExitPlan,
  type ExitPlanView,
  type ExitRule,
  type ExitRuleInput,
} from '../shared/exits';
import { costBasis } from '../shared/pnl';
import { isSolana } from '../shared/solana';
import { hasEvm } from '../shared/wallet';
import { readBalances } from './balances';
import type { HistoryStore } from './history';
import { readTokenMeta } from './resolve';
import { SettingsError } from './settings';
import { chainContext, shortErr, type EngineDeps, type TradeEngine } from './trade/engine';
import type { Routing } from './trade/routing';
import type { Vault } from './vault/vault';

const KEY = 'nesty.exits';
/** How often prices are checked while the worker is awake. */
export const EXIT_CHECK_MS = 900;

/** What exit plans need of Solana: holdings, what selling them returns, and the sell. */
export interface SolanaExits {
  /** What each of these wallets with a Solana address holds of `mint`, and its symbol. */
  holdingsOf(
    mint: string,
    walletIds: readonly string[],
  ): Promise<{ held: Held[]; symbol: string | null }>;
  /**
   * What selling `amount` returns now, in what the coin is bought with (`unit`: null for SOL,
   * else the token's mint); or why it can't.
   */
  sellValue(
    mint: string,
    amount: bigint,
  ): Promise<{ out: bigint; unit: string | null } | { why: string }>;
  sell(req: {
    mint: string;
    bps: number;
    walletIds: string[];
    confirmed: boolean;
  }): Promise<unknown>;
}

export type ExitDeps = Pick<
  EngineDeps,
  'settings' | 'client' | 'fetchJson' | 'aggregator' | 'now'
> & {
  local: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  history: HistoryStore;
  vault: Vault;
  routing: Routing;
  engine: Pick<TradeEngine, 'sell'>;
  solana: SolanaExits;
};

type Status = Pick<ExitPlanView, 'nowBps' | 'checkedAt' | 'paused'>;
type Held = { walletId: string; token: bigint };

// Solana mints are base58: compared exactly, never case-folded.
const sameToken = (chainId: number, a: string, b: string) =>
  isSolana(chainId) ? a === b : isAddressEqual(a as Address, b as Address);
const same = (p: ExitPlan, chainId: number, token: string) =>
  p.chainId === chainId && sameToken(chainId, p.token, token);
const keyOf = (chainId: number, token: string) =>
  `${chainId}:${isSolana(chainId) ? token : token.toLowerCase()}`;

/**
 * Take profit and stop loss: per token, a few steps that each sell part of the holding
 * when the price reaches a multiple of the average cost. Checked about every second while
 * the browser runs; each sell goes through the usual engine (on Solana, the Solana
 * service), validator included.
 */
export class ExitWatcher {
  private cache: ExitPlan[] | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly status = new Map<string, Status>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly d: ExitDeps) {}

  private async plans(): Promise<ExitPlan[]> {
    if (!this.cache) {
      const v = await this.d.local.get(KEY);
      this.cache = Array.isArray(v) ? (v as ExitPlan[]) : [];
    }
    return this.cache;
  }

  /** Serialised read-modify-write, like the activity log. */
  private write(fn: (list: ExitPlan[]) => ExitPlan[]): Promise<void> {
    const run = this.queue.then(async () => {
      this.cache = fn([...(await this.plans())]);
      await this.d.local.set(KEY, this.cache);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private view(p: ExitPlan): ExitPlanView {
    const s = this.status.get(keyOf(p.chainId, p.token));
    return {
      ...p,
      nowBps: s?.nowBps ?? null,
      checkedAt: s?.checkedAt ?? null,
      paused: s?.paused ?? null,
    };
  }

  async list(chainId?: number): Promise<ExitPlanView[]> {
    return (await this.plans())
      .filter((p) => chainId === undefined || p.chainId === chainId)
      .map((p) => this.view(p));
  }

  async get(chainId: number, token: string): Promise<ExitPlanView | null> {
    const p = (await this.plans()).find((x) => same(x, chainId, token));
    return p ? this.view(p) : null;
  }

  async set(req: {
    chainId: number;
    token: string;
    walletIds: string[];
    rules: ExitRuleInput[];
  }): Promise<ExitPlanView> {
    const sol = isSolana(req.chainId);
    const token = sol ? req.token : getAddress(req.token);
    const [{ held, symbol }, history] = await Promise.all([
      this.holdings(req.chainId, token, req.walletIds),
      this.d.history.list(),
    ]);
    if (held.length === 0) throw new SettingsError('Pick a wallet that holds this token.');
    const { covered } = coveredCost(held, costBasis(history, req.chainId, token));
    // Targets are multiples of the average cost, so a holding without one has nothing to measure.
    if (covered === 0n)
      throw new SettingsError('These wallets hold none of this token bought through Nesty.');

    const prev = (await this.plans()).find((p) => same(p, req.chainId, token));
    if (!prev && (await this.plans()).length >= MAX_EXIT_PLANS)
      throw new SettingsError(`At most ${MAX_EXIT_PLANS} tokens can have an exit plan.`);
    const plan: ExitPlan = {
      chainId: req.chainId,
      token,
      symbol: symbol ?? prev?.symbol ?? '',
      walletIds: held.map((h) => h.walletId),
      rules: mergeRules(prev?.rules ?? [], req.rules),
      createdAt: prev?.createdAt ?? this.d.now(),
    };
    if (prev?.peakBps !== undefined) plan.peakBps = prev.peakBps;
    await this.write((list) => [...list.filter((p) => !same(p, req.chainId, token)), plan]);
    this.start();
    return this.view(plan);
  }

  /** What these wallets hold of the token, those with an address on its network only. */
  private async holdings(
    chainId: number,
    token: string,
    walletIds: readonly string[],
  ): Promise<{ held: Held[]; symbol: string | null }> {
    if (isSolana(chainId)) return this.d.solana.holdingsOf(token, walletIds);
    const { ctx } = await chainContext(this.d, chainId);
    const wallets = (await this.d.vault.listAccounts()).filter(
      (a) => hasEvm(a) && walletIds.includes(a.id),
    );
    if (wallets.length === 0) return { held: [], symbol: null };
    const [balances, meta] = await Promise.all([
      readBalances(
        ctx.client,
        token as Address,
        wallets.map((w) => w.address as Address),
      ),
      readTokenMeta(ctx.client, token as Address),
    ]);
    return {
      held: wallets.map((w, i) => ({ walletId: w.id, token: balances[i]?.token ?? 0n })),
      symbol: meta?.symbol ?? null,
    };
  }

  /**
   * What selling `amount` returns now, in the coin's cost currency (`unit` on Solana, see
   * SolanaExits); or why it can't be sold.
   */
  private async sellValue(
    chainId: number,
    token: string,
    amount: bigint,
  ): Promise<{ out: bigint; unit?: string | null } | { why: string }> {
    if (isSolana(chainId)) return this.d.solana.sellValue(token, amount);
    const { ctx } = await chainContext(this.d, chainId);
    const [route] = await this.d.routing.best(ctx, token as Address, 'sell', [amount]);
    if (route) return { out: route.out };
    return {
      why: (await this.d.routing.whyNone(ctx, token as Address)) ?? 'No route to sell right now.',
    };
  }

  async remove(chainId: number, token: string): Promise<void> {
    await this.write((list) => list.filter((p) => !same(p, chainId, token)));
    this.status.delete(keyOf(chainId, token));
  }

  /** Starts checking if any plan is open; called on wake-up and after a save. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), EXIT_CHECK_MS);
    void this.tick();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every plan. Plans on different chains are checked in parallel. */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const list = await this.plans();
      if (list.length === 0) return this.stop();
      const unlocked = await this.d.vault.isUnlocked();
      await Promise.all(
        list.map((p) =>
          this.check(p, unlocked).catch(() =>
            this.setStatus(p, { paused: 'Price check failed; trying again.' }),
          ),
        ),
      );
    } finally {
      this.checking = false;
    }
  }

  private setStatus(p: ExitPlan, s: Partial<Status>) {
    const k = keyOf(p.chainId, p.token);
    const prev = this.status.get(k) ?? { nowBps: null, checkedAt: null, paused: null };
    this.status.set(k, { ...prev, ...s });
  }

  private async check(p: ExitPlan, unlocked: boolean): Promise<void> {
    if (!unlocked) return this.setStatus(p, { paused: 'Paused while Nesty is locked.' });
    const token = p.token;
    const [{ held }, history] = await Promise.all([
      this.holdings(p.chainId, token, p.walletIds),
      this.d.history.list(),
    ]);
    const total = held.reduce((s, h) => s + h.token, 0n);
    if (total === 0n) {
      // Sold out (by the plan or by hand): nothing left to watch.
      if (p.rules.some((r) => r.firedAt)) return this.remove(p.chainId, token);
      return this.setStatus(p, { paused: 'These wallets hold none of it now.' });
    }
    const value = await this.sellValue(p.chainId, token, total);
    if ('why' in value) return this.setStatus(p, { paused: value.why });
    // Costs in the currency the value is in: a Solana coin bought with a token once and with
    // SOL now counts only its SOL buys.
    const { covered, costWei } = coveredCost(
      held,
      costBasis(history, p.chainId, token, value.unit),
    );
    if (covered === 0n) return this.setStatus(p, { paused: 'No cost on record for what is held.' });

    const nowBps = multipleBps(value.out, total, covered, costWei);
    this.setStatus(p, { nowBps, checkedAt: this.d.now(), paused: null });
    const { rule, peakBps } = dueRule(p, nowBps);
    if (peakBps !== p.peakBps) await this.patch(p, (x) => ({ ...x, peakBps }));
    if (!rule) return;

    // Marked first, so a slow sell is never sent twice by the next check.
    await this.patchRule(p, rule.id, { done: true });
    const holders = held.filter((h) => h.token > 0n).map((h) => h.walletId);
    try {
      if (isSolana(p.chainId))
        await this.d.solana.sell({
          mint: token,
          bps: rule.sellBps,
          walletIds: holders,
          confirmed: true,
        });
      else
        await this.d.engine.sell({
          chainId: p.chainId,
          token: token as Address,
          bps: rule.sellBps,
          walletIds: holders,
          confirmed: true,
        });
      // Sold: the earlier failure no longer applies.
      await this.patchRule(p, rule.id, { firedAt: this.d.now(), error: undefined });
    } catch (e) {
      const tries = (rule.tries ?? 0) + 1;
      await this.patchRule(p, rule.id, {
        done: tries >= EXIT_TRIES,
        tries,
        error: shortErr(e).slice(0, 140),
      });
    }
  }

  private patch(p: ExitPlan, fn: (x: ExitPlan) => ExitPlan): Promise<void> {
    return this.write((list) => list.map((x) => (same(x, p.chainId, p.token) ? fn(x) : x)));
  }

  private patchRule(
    p: ExitPlan,
    id: string,
    fields: { [K in keyof ExitRule]?: ExitRule[K] | undefined },
  ): Promise<void> {
    return this.patch(p, (x) => ({
      ...x,
      rules: x.rules.map((r) => {
        if (r.id !== id) return r;
        const next: ExitRule = { ...r };
        for (const [k, v] of Object.entries(fields) as [keyof ExitRule, unknown][]) {
          if (v === undefined) Reflect.deleteProperty(next, k);
          else Object.assign(next, { [k]: v });
        }
        return next;
      }),
    }));
  }
}
