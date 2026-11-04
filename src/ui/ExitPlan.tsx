import { useEffect, useState } from 'preact/hooks';
import { MAX_EXIT_RULES, ruleText, type ExitPlanView, type ExitRuleInput } from '../shared/exits';
import { errorText, send } from './api';

type Kind = ExitRuleInput['kind'];

/** A step as typed: the trigger as "2" (x) or "40" (%), the sell share in %. */
interface Draft {
  id: string;
  kind: Kind;
  trigger: string;
  sell: string;
}

const KIND_TEXT: Record<Kind, string> = {
  tp: 'Take profit',
  sl: 'Stop loss',
  trail: 'Trailing stop',
};
const NEW_STEP: Record<Kind, Pick<Draft, 'trigger' | 'sell'>> = {
  tp: { trigger: '2', sell: '50' },
  sl: { trigger: '40', sell: '100' },
  trail: { trigger: '25', sell: '100' },
};
const POLL_MS = 900;

const trim = (n: number) => String(Math.round(n * 100) / 100);
const toDraft = (r: ExitRuleInput): Draft => ({
  id: r.id,
  kind: r.kind,
  trigger: r.kind === 'tp' ? trim(r.triggerBps / 10_000) : trim(r.triggerBps / 100),
  sell: trim(r.sellBps / 100),
});

/** The typed step as a rule, or why it is not one yet. */
function parse(d: Draft): ExitRuleInput | string {
  const trigger = Number(d.trigger);
  const sell = Number(d.sell);
  if (!Number.isFinite(sell) || sell <= 0 || sell > 100) return 'Sell between 1% and 100%.';
  if (d.kind === 'tp') {
    if (!Number.isFinite(trigger) || trigger <= 1 || trigger > 100)
      return 'Take profit between 1x and 100x.';
  } else if (!Number.isFinite(trigger) || trigger <= 0 || trigger >= 100) {
    return 'A drop between 1% and 99%.';
  }
  return {
    id: d.id,
    kind: d.kind,
    triggerBps: Math.round(trigger * (d.kind === 'tp' ? 10_000 : 100)),
    sellBps: Math.round(sell * 100),
  };
}

/** What a step's trigger is in price terms, from the multiple of cost now. */
function distance(r: ExitPlanView['rules'][number], plan: ExitPlanView): string | null {
  if (plan.nowBps === null || plan.nowBps <= 0) return null;
  const at =
    r.kind === 'tp'
      ? r.triggerBps
      : r.kind === 'sl'
        ? 10_000 - r.triggerBps
        : ((plan.peakBps ?? plan.nowBps) * (10_000 - r.triggerBps)) / 10_000;
  const pct = (at / plan.nowBps - 1) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : trim(Math.abs(pct))}% away`;
}

/**
 * Take profit and stop loss for one token: a short list of steps, edited in place. Shared
 * by the trading panel and the popup's token page.
 */
export function ExitPlan({
  chainId,
  token,
  walletIds,
  canSet,
}: {
  chainId: number;
  token: string;
  /** Wallets the plan watches and sells from. */
  walletIds: string[];
  /** False when there is nothing bought through Nesty to measure from. */
  canSet: boolean;
}) {
  const [plan, setPlan] = useState<ExitPlanView | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      void send({ type: 'exits.get', chainId, token }).then((r) => {
        if (live && r.ok) setPlan(r.data);
      });
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [chainId, token]);

  if (plan === undefined) return null;
  if (!plan && !canSet && !drafts) return null;

  const edit = () => {
    setMsg(null);
    setDrafts(
      plan
        ? plan.rules.map(toDraft)
        : [
            { id: crypto.randomUUID(), kind: 'tp', ...NEW_STEP.tp },
            { id: crypto.randomUUID(), kind: 'sl', ...NEW_STEP.sl },
          ],
    );
  };

  if (drafts) {
    const parsed = drafts.map(parse);
    const firstError = parsed.find((p): p is string => typeof p === 'string');
    const set = (i: number, patch: Partial<Draft>) =>
      setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    const save = async () => {
      const rules = parsed.filter((p): p is ExitRuleInput => typeof p !== 'string');
      setBusy(true);
      setMsg(null);
      const r =
        rules.length === 0
          ? await send({ type: 'exits.remove', chainId, token })
          : await send({ type: 'exits.set', chainId, token, walletIds, rules });
      setBusy(false);
      if (!r.ok) return setMsg(errorText(r));
      setPlan(r.data);
      setDrafts(null);
    };
    return (
      <form
        class="xp xp--edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (!firstError && !busy) void save();
        }}
      >
        <div class="xp-head">
          <span class="xp-title">Exit plan</span>
        </div>
        {drafts.map((d, i) => (
          <div key={d.id} class={`xp-step xp-${d.kind}`}>
            <span class="xp-kind">{KIND_TEXT[d.kind]}</span>
            <label
              class="xp-in"
              title={
                d.kind === 'tp'
                  ? 'Price as a multiple of your average cost'
                  : d.kind === 'sl'
                    ? 'Drop from your average cost'
                    : 'Drop from the highest price since set'
              }
            >
              {d.kind !== 'tp' && <span>−</span>}
              <input
                inputMode="decimal"
                aria-label={`${KIND_TEXT[d.kind]} trigger`}
                value={d.trigger}
                onInput={(e) => set(i, { trigger: e.currentTarget.value })}
              />
              <span>{d.kind === 'tp' ? 'x' : '%'}</span>
            </label>
            <label class="xp-in" title="Share of what is held at that moment">
              <span>sell</span>
              <input
                inputMode="decimal"
                aria-label={`${KIND_TEXT[d.kind]} sell share`}
                value={d.sell}
                onInput={(e) => set(i, { sell: e.currentTarget.value })}
              />
              <span>%</span>
            </label>
            <button
              type="button"
              class="xp-x"
              aria-label={`Remove ${KIND_TEXT[d.kind].toLowerCase()} step`}
              onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        {drafts.length < MAX_EXIT_RULES && (
          <div class="xp-add">
            {(['tp', 'sl', 'trail'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() =>
                  setDrafts([...drafts, { id: crypto.randomUUID(), kind: k, ...NEW_STEP[k] }])
                }
              >
                + {KIND_TEXT[k]}
              </button>
            ))}
          </div>
        )}
        <p class="xp-note">
          Measured from your average cost. Sells without asking while the browser is open.
        </p>
        {(msg ?? firstError) && <p class="xp-err">{msg ?? firstError}</p>}
        <div class="xp-acts">
          {plan && (
            <button
              type="button"
              class="xp-btn xp-btn--danger"
              disabled={busy}
              onClick={() => setDrafts([])}
              title="Clears every step; Save to remove the plan"
            >
              Clear
            </button>
          )}
          <span class="xp-sp" />
          <button type="button" class="xp-btn" onClick={() => setDrafts(null)}>
            Cancel
          </button>
          <button type="submit" class="xp-btn xp-btn--on" disabled={!!firstError || busy}>
            {busy ? 'Saving…' : drafts.length === 0 ? 'Remove plan' : 'Save'}
          </button>
        </div>
      </form>
    );
  }

  if (!plan)
    return (
      <button type="button" class="xp-set" onClick={edit}>
        <span>+ Set take profit / stop loss</span>
      </button>
    );

  return (
    <div class="xp" role="group" aria-label="Exit plan">
      <div class="xp-head">
        <span class="xp-title">Exit plan</span>
        <span class={`xp-now${plan.paused ? ' off' : ''}`}>
          {plan.paused ??
            (plan.nowBps !== null ? `Now ${trim(plan.nowBps / 10_000)}x` : 'Checking…')}
        </span>
        <span class="xp-sp" />
        <button type="button" class="xp-link" onClick={edit}>
          Edit
        </button>
      </div>
      <ul class="xp-list">
        {plan.rules.map((r) => (
          <li key={r.id} class={`xp-row xp-${r.kind}${r.done ? ' done' : ''}`}>
            <i class="xp-dot" aria-hidden="true" />
            <span class="xp-what">{ruleText(r)}</span>
            <span class="xp-state">
              {r.firedAt
                ? 'Sold ✓'
                : r.done
                  ? 'Failed'
                  : r.error
                    ? `Retrying (${r.tries ?? 1})`
                    : (distance(r, plan) ?? '')}
            </span>
          </li>
        ))}
      </ul>
      {plan.rules.some((r) => r.error && !r.firedAt) && (
        <p class="xp-err">{plan.rules.find((r) => r.error && !r.firedAt)?.error}</p>
      )}
    </div>
  );
}
