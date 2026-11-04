import { useEffect, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import { browser } from 'wxt/browser';
import { nativeSymbol, networkName, networkShort } from '../../shared/networks';
import { nativeDecimals } from '../../shared/solana';
import { formatCompact, formatDuration, formatToken } from '../../shared/format';
import type { PushEvent } from '../../shared/messages';
import { readyMs, type TicketLeg, type TradeTicket } from '../../shared/panel';
import { send } from '../../ui/api';

type Filter = 'all' | 'buy' | 'sell' | 'bridge' | 'transfer';
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['buy', 'Buys'],
  ['sell', 'Sells'],
  ['bridge', 'Bridge'],
  ['transfer', 'Transfers'],
];

function matches(t: TradeTicket, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'transfer') return t.kind === 'distribute' || t.kind === 'collect' || t.kind === 'send';
  return t.kind === f;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function chainShort(id: number): string {
  return networkShort(id);
}

export function nativeSym(id: number): string {
  return nativeSymbol(id);
}

export function statusOf(t: TradeTicket): { text: string; cls: string } {
  const swaps = t.legs.filter((l) => l.kind !== 'approve');
  const done = swaps.filter((l) => l.status === 'confirmed').length;
  if (t.kind === 'bridge' && t.bridge) {
    const s = t.bridge.relayStatus;
    if (t.status === 'failed' || t.status === 'blocked')
      return { text: s === 'refund' ? 'Refunded' : 'Failed', cls: 'bad' };
    if (s === 'success') return { text: 'Completed', cls: 'ok' };
    return { text: done ? 'Bridging' : 'Pending', cls: 'pend' };
  }
  switch (t.status) {
    case 'done':
      return { text: 'Confirmed', cls: 'ok' };
    case 'working':
      return { text: 'Pending', cls: 'pend' };
    case 'partial':
      return { text: `${done}/${swaps.length} wallets`, cls: 'ok' };
    case 'blocked':
      return { text: 'Blocked', cls: 'bad' };
    case 'failed':
      return { text: 'Failed', cls: 'bad' };
  }
}

export function title(t: TradeTicket): string {
  switch (t.kind) {
    case 'buy':
      return `Buy ${t.symbol ?? 'token'}`;
    case 'sell':
      return `Sell ${t.symbol ?? 'token'}`;
    case 'bridge':
      return `Bridge ${networkName(t.chainId)} → ${t.bridge ? networkName(t.bridge.toChainId) : ''}`;
    case 'distribute':
      return 'Distribute';
    case 'collect':
      return 'Collect';
    case 'send':
      return `Send ${t.symbol ?? nativeSym(t.chainId)}`;
  }
}

/** A ticket's own legs: approvals, and the steps around a funded curve's trade, left out. */
export const swapLegs = (t: TradeTicket) =>
  t.legs.filter((l) => l.kind !== 'approve' && l.kind !== 'step');

const sum = (xs: (string | undefined)[]) => xs.reduce((s, x) => s + BigInt(x ?? '0'), 0n);
const native = (wei: bigint, chainId: number) =>
  `${formatCompact(Number(formatUnits(wei, nativeDecimals(chainId))))} ${nativeSym(chainId)}`;

/** What a trade paid or got back: the native coin, or the token a Solana coin is bought with. */
export const payUnitOf = (t: TradeTicket): { symbol: string; decimals: number } =>
  t.pay ?? { symbol: nativeSym(t.chainId), decimals: nativeDecimals(t.chainId) };
const paidIn = (raw: bigint, t: TradeTicket) => {
  const u = payUnitOf(t);
  return `${formatCompact(Number(formatUnits(raw, u.decimals)))} ${u.symbol}`;
};

/**
 * Totals across wallets; `out` only when every confirmed wallet has its amount. A funded
 * curve's buy paid native in its first step, and its sell got native back in its last.
 */
export function totals(t: TradeTicket): { paid: bigint; out: bigint | null } {
  const swaps = swapLegs(t).filter((l) => l.status !== 'skipped' && l.status !== 'blocked');
  const stepOf = (l: TicketLeg) =>
    t.legs.find((x) => x.kind === 'step' && x.walletId === l.walletId);
  const paidBy = (l: TicketLeg) =>
    (t.kind === 'buy' ? stepOf(l)?.amountIn : undefined) ?? l.amountIn;
  const outBy = (l: TicketLeg) =>
    (t.kind === 'sell' ? stepOf(l)?.amountOut : undefined) ?? l.amountOut;
  const done = swaps.filter((l) => l.status === 'confirmed');
  const known = done.length > 0 && done.every((l) => outBy(l) !== undefined);
  return {
    paid: sum(swaps.map(paidBy)),
    out: known ? sum(done.map(outBy)) : null,
  };
}

function summary(t: TradeTicket): string {
  const swaps = swapLegs(t);
  const names = [...new Set(swaps.map((l) => l.walletName))];
  const who = names.length > 1 ? `${names.length} wallets` : (names[0] ?? '');
  if (t.kind === 'bridge' && t.bridge) {
    return `${native(BigInt(t.bridge.amountIn), t.chainId)} → ${native(BigInt(t.bridge.amountOut), t.bridge.toChainId)}`;
  }
  const failed = swaps.find((l) => l.error)?.error;
  if (failed && (t.status === 'failed' || t.status === 'blocked')) return failed;
  if (t.kind === 'send' && t.recipient) {
    const amt =
      t.token && t.decimals !== undefined
        ? `${formatToken(sum(swaps.map((l) => l.amountIn)), t.decimals)} ${t.symbol ?? ''}`
        : native(sum(swaps.map((l) => l.amountIn)), t.chainId);
    return `${amt} → ${t.recipient.slice(0, 6)}…${t.recipient.slice(-4)}`;
  }
  const sym = t.symbol ?? 'token';
  const { paid, out } = totals(t);
  if (t.kind === 'buy') {
    const got =
      out !== null && t.decimals !== undefined ? ` → ${formatToken(out, t.decimals)} ${sym}` : '';
    return `${paidIn(paid, t)}${got} · ${who}`;
  }
  if (t.kind === 'sell') {
    const sold = t.decimals !== undefined ? `${formatToken(paid, t.decimals)} ${sym}` : sym;
    return `${sold}${out !== null ? ` → ${paidIn(out, t)}` : ''} · ${who}`;
  }
  return `${native(paid, t.chainId)} · ${who}`;
}

const ICON: Record<TradeTicket['kind'], [string, string]> = {
  buy: ['↓', 'b'],
  sell: ['↑', 's'],
  bridge: ['⇄', 'x'],
  distribute: ['→', 't'],
  collect: ['←', 't'],
  send: ['↗', 't'],
};

export function TicketIcon({ t }: { t: TradeTicket }) {
  const [glyph, cls] = ICON[t.kind];
  return <span class={`ico ${cls}`}>{glyph}</span>;
}

/** History plus live updates pushed by the background. */
export function useHistory(): TradeTicket[] | null {
  const [items, setItems] = useState<TradeTicket[] | null>(null);
  useEffect(() => {
    void send({ type: 'history.list' }).then((r) => setItems(r.ok ? r.data : []));
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = m as PushEvent;
      if (ev?.kind !== 'nesty.ticket') return;
      setItems((prev) => {
        const list = prev ?? [];
        const i = list.findIndex((t) => t.id === ev.ticket.id);
        if (i < 0) return [ev.ticket, ...list];
        const next = [...list];
        next[i] = ev.ticket;
        return next;
      });
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);
  return items;
}

// Kept across opening a ticket and coming back.
let lastFilter: Filter = 'all';

export function Activity({
  chainFilter,
  onOpen,
}: {
  chainFilter: number;
  onOpen: (id: string) => void;
}) {
  const items = useHistory();
  const [filter, setFilterState] = useState<Filter>(lastFilter);
  const setFilter = (f: Filter) => {
    lastFilter = f;
    setFilterState(f);
  };

  const shown = (items ?? []).filter(
    (t) => matches(t, filter) && (t.chainId === chainFilter || t.bridge?.toChainId === chainFilter),
  );
  let lastDay = '';

  return (
    <div class="stack" style={{ gap: '8px' }}>
      <div class="chips" role="tablist" aria-label="Filter">
        {FILTERS.map(([f, label]) => (
          <button
            key={f}
            type="button"
            role="tab"
            class="chip"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
          >
            {label}
          </button>
        ))}
      </div>
      {items === null && <p class="muted">Loading…</p>}
      {items !== null && shown.length === 0 && (
        <p class="center muted" style={{ padding: '32px 8px' }}>
          No activity on {networkName(chainFilter)} yet. Trades, bridges and transfers show up here;
          switch chain at the top to see others.
        </p>
      )}
      {shown.map((t) => {
        const day = dayLabel(t.createdAt);
        const header = day !== lastDay ? <div class="day">{day}</div> : null;
        lastDay = day;
        const st = statusOf(t);
        // Nesty's own part (click → signed); records from before the split show the total.
        const first = swapLegs(t).find((l) => l.sentMs !== undefined);
        const readyFirst = first && readyMs(first);
        const firstMs = readyFirst ?? first?.sentMs;
        return (
          <div key={t.id}>
            {header}
            <button type="button" class="card act" onClick={() => onOpen(t.id)}>
              <TicketIcon t={t} />
              <span class="t1">
                {title(t)}
                {t.kind !== 'bridge' && <span class="cb">{chainShort(t.chainId)}</span>}
              </span>
              <span class={`r1 ${st.cls}`}>{st.text}</span>
              <span class="t2">{summary(t)}</span>
              <span class="r2">
                {firstMs !== undefined && (
                  <span
                    class="r-ms"
                    title={readyFirst !== undefined ? 'Click to ready' : 'Click to sent'}
                  >
                    {formatDuration(firstMs)} ·{' '}
                  </span>
                )}
                {time(t.createdAt)}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
