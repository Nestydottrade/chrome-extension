import { z } from 'zod';
import { coveredPart, type CostBasis } from './pnl';

/** A token's plan holds at most this many steps. */
export const MAX_EXIT_RULES = 8;
/** Plans watched at once, across chains. */
export const MAX_EXIT_PLANS = 30;
/** Times a step's sell is tried before it is given up and shown as failed. */
export const EXIT_TRIES = 3;

const Bps = z.number().int();

/**
 * One step of an exit plan. Take profit fires at a price multiple of the average cost
 * (`triggerBps` 20_000 = 2x). Stop loss fires at a drop from the average cost, and a
 * trailing stop at a drop from the highest price seen since the plan was set (`triggerBps`
 * 4_000 = 40% down). Each sells `sellBps` of what the wallets hold at that moment.
 */
export const ExitRuleInputSchema = z
  .object({
    id: z.string().min(1).max(40),
    kind: z.enum(['tp', 'sl', 'trail']),
    triggerBps: Bps.min(1).max(1_000_000),
    sellBps: Bps.min(1).max(10_000),
  })
  .strict()
  .refine((r) => (r.kind === 'tp' ? r.triggerBps > 10_000 : r.triggerBps < 10_000), {
    message: 'Take profit must be above 1x; a stop must be a drop below 100%.',
  });
export type ExitRuleInput = z.infer<typeof ExitRuleInputSchema>;

export interface ExitRule extends ExitRuleInput {
  /** Sold (or given up after EXIT_TRIES). */
  done?: boolean;
  /** Failed sell attempts so far. */
  tries?: number;
  /** Why the last attempt failed. */
  error?: string;
  /** When it fired and sold. */
  firedAt?: number;
}

export interface ExitPlan {
  chainId: number;
  token: string;
  symbol: string;
  /** The wallets it watches and sells from. */
  walletIds: string[];
  rules: ExitRule[];
  createdAt: number;
  /** Highest multiple of the average cost seen since it was set, for trailing stops. */
  peakBps?: number;
}

/** A plan with what the watcher last saw. */
export interface ExitPlanView extends ExitPlan {
  /** Current price as a multiple of the average cost, in bps; null before the first check. */
  nowBps: number | null;
  checkedAt: number | null;
  /** Why it is not checking now (locked, no route…); null when it is. */
  paused: string | null;
}

/**
 * The covered part of a holding and what it cost: tokens a wallet got outside Nesty have
 * no cost and are left out, as in unrealised PnL.
 */
export function coveredCost(
  held: readonly { walletId: string; token: bigint }[],
  basis: ReadonlyMap<string, CostBasis>,
): { covered: bigint; costWei: bigint } {
  let covered = 0n;
  let costWei = 0n;
  for (const h of held) {
    const b = basis.get(h.walletId);
    if (!b) continue;
    const part = coveredPart(h.token, b);
    covered += part.tokens;
    costWei += part.costWei;
  }
  return { covered, costWei };
}

/**
 * Price now as a multiple of the average cost, in bps: what selling the whole holding
 * returns (`out` for `held` tokens, impact included) against what the covered part cost.
 */
export function multipleBps(out: bigint, held: bigint, covered: bigint, costWei: bigint): number {
  if (held <= 0n || covered <= 0n || costWei <= 0n) return 0;
  return Number((out * covered * 10_000n) / (held * costWei));
}

/**
 * The step to fire now, if any, and the new peak. One step per check: the sell changes the
 * holding, and the next check measures again. Stops win over take profits; among equals,
 * the one that sells more.
 */
export function dueRule(
  plan: Pick<ExitPlan, 'rules' | 'peakBps'>,
  nowBps: number,
): { rule: ExitRule | null; peakBps: number } {
  const peakBps = Math.max(plan.peakBps ?? 0, nowBps);
  const hit = (r: ExitRule) =>
    r.kind === 'tp'
      ? nowBps >= r.triggerBps
      : r.kind === 'sl'
        ? nowBps <= 10_000 - r.triggerBps
        : nowBps <= (peakBps * (10_000 - r.triggerBps)) / 10_000;
  const due = plan.rules
    .filter((r) => !r.done && hit(r))
    .sort((a, b) => Number(a.kind === 'tp') - Number(b.kind === 'tp') || b.sellBps - a.sellBps);
  return { rule: due[0] ?? null, peakBps };
}

/**
 * Saving a plan again keeps the progress of steps that did not change (a fired step stays
 * fired), so editing one step never re-arms the others.
 */
export function mergeRules(prev: readonly ExitRule[], next: readonly ExitRuleInput[]): ExitRule[] {
  return next.map((r) => {
    const old = prev.find((p) => p.id === r.id);
    const same =
      old && old.kind === r.kind && old.triggerBps === r.triggerBps && old.sellBps === r.sellBps;
    return same ? { ...old } : { ...r };
  });
}

/** Short label for a step: "2x · sell 50%". */
export function ruleText(r: ExitRuleInput): string {
  const sell = r.sellBps === 10_000 ? 'sell all' : `sell ${trimPct(r.sellBps)}`;
  if (r.kind === 'tp') return `${trimNum(r.triggerBps / 10_000)}x · ${sell}`;
  if (r.kind === 'sl') return `−${trimPct(r.triggerBps)} · ${sell}`;
  return `−${trimPct(r.triggerBps)} from peak · ${sell}`;
}

const trimNum = (n: number) => String(Math.round(n * 100) / 100);
const trimPct = (bps: number) => `${trimNum(bps / 100)}%`;
