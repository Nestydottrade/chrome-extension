import { useEffect, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import { formatCompact, formatDuration, formatToken, formatUsd } from '../../shared/format';
import { readyMs, type TicketLeg, type TradeTicket } from '../../shared/panel';
import { SOLANA, isSolana, nativeDecimals } from '../../shared/solana';
import { SpeedLegend, SpeedStrip } from '../../ui/SpeedStrip';
import { trusted } from './hooks';
import { CloseIcon } from './icons';

export interface ToastItem {
  id: string;
  ticket?: TradeTicket;
  error?: string;
  /** Heading of an error toast (what did not happen). */
  title?: string;
  retry?: boolean;
}

/** How long a finished toast stays up (paused while hovered). Working tickets stay. */
const LIFETIME_MS = 3_000;

const DOING: Record<TradeTicket['kind'], string> = {
  buy: 'Buying',
  sell: 'Selling',
  distribute: 'Distributing',
  collect: 'Collecting',
  bridge: 'Bridging',
  send: 'Sending',
};

const DONE: Record<TradeTicket['kind'], string> = {
  buy: 'Buy',
  sell: 'Sell',
  distribute: 'Distribute',
  collect: 'Collect',
  bridge: 'Bridge',
  send: 'Send',
};

/** Ms until auto-close, or null to stay until dismissed. */
function lifetime(item: ToastItem): number | null {
  if (item.error) return LIFETIME_MS;
  const t = item.ticket;
  if (!t || t.status === 'working') return null;
  // A transaction still in flight can be sped up or cancelled: keep it visible.
  if (t.legs.some((l) => l.status === 'submitted' || l.status === 'sending')) return null;
  return LIFETIME_MS;
}

/** What one wallet's row says while the ticket is working. */
function legState(leg: TicketLeg) {
  const ready = readyMs(leg);
  switch (leg.status) {
    case 'queued':
      return <span class="t-quiet">Queued</span>;
    case 'sending':
      return <span class="t-quiet">Checking balance and simulating…</span>;
    case 'submitted':
    case 'confirmed':
      return (
        <span class="t-sent">
          {leg.status === 'confirmed' ? 'Confirmed' : 'Sent'}
          {ready !== undefined ? (
            <>
              {' '}
              · {formatDuration(ready)}{' '}
              <span class="t-quiet">+ {formatDuration(leg.phases?.sendMs ?? 0)} network</span>
            </>
          ) : (
            leg.sentMs !== undefined && ` · ${formatDuration(leg.sentMs)}`
          )}
        </span>
      );
    default:
      return <span class="t-bad">{leg.status === 'skipped' ? 'Skipped' : 'Failed'}</span>;
  }
}

/** Ways to act on a sent transaction: replace it, or fill the gap it waits behind. */
export type ReplaceMode = 'speedUp' | 'cancel' | 'unstick';

export function Toasts(props: {
  items: ToastItem[];
  decimals: number;
  native: string;
  /** The panel token symbol, used until the ticket carries its own. */
  symbol: string;
  /** Where the stack sits (kept clear of the panel). */
  placement?: Record<string, string>;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
  onReplace: (ticketId: string, walletId: string, mode: ReplaceMode) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div class="toasts" role="status" aria-live="polite" style={props.placement}>
      {props.items.map((item) => (
        <Toast key={item.id} item={item} {...props} />
      ))}
    </div>
  );
}

function Toast({
  item,
  decimals,
  native,
  symbol,
  onDismiss,
  onRetry,
  onReplace,
}: Parameters<typeof Toasts>[0] & { item: ToastItem }) {
  const ms = lifetime(item);
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-close once finished; hovering pauses (and restarts) the countdown.
  useEffect(() => {
    if (ms === null || hover) return;
    const id = setTimeout(() => onDismiss(item.id), ms);
    return () => clearTimeout(id);
  }, [ms, hover, item.id]);

  const dismiss = (
    <button
      type="button"
      class="ib t-x"
      aria-label="Dismiss"
      onClick={trusted(() => onDismiss(item.id))}
    >
      <CloseIcon />
    </button>
  );
  const timer = ms !== null && !hover && (
    // Restarted by key whenever the countdown restarts.
    <span key={`${ms}-${String(hover)}`} class="ttl" style={{ animationDuration: `${ms}ms` }} />
  );
  const hoverProps = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };
  const copyDetails = (text: string) =>
    trusted(() => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_200);
      });
    });

  if (item.error) {
    return (
      <article class="toast bad" {...hoverProps}>
        <div class="t-head">
          <strong>{item.title ?? 'Trade not sent'}</strong>
          {dismiss}
        </div>
        <p class="t-msg">{item.error}</p>
        <div class="t-acts">
          {item.retry && (
            <button type="button" class="btn t-retry" onClick={trusted(() => onRetry(item.id))}>
              Try again
            </button>
          )}
          <button type="button" class="btn t-ghost" onClick={copyDetails(item.error)}>
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
        {timer}
      </article>
    );
  }

  const t = item.ticket as TradeTicket;
  const sym = t.symbol ?? symbol;
  // A Solana coin bought with a token (USDC, say) paid and got back that token.
  const nd = t.pay?.decimals ?? nativeDecimals(t.chainId);
  const unit = t.pay?.symbol ?? (isSolana(t.chainId) ? SOLANA.nativeCurrency.symbol : native);
  const nat = (raw: bigint) => Number(formatUnits(raw, nd));
  const swaps = t.legs.filter((l) => l.kind !== 'approve' && l.kind !== 'step');
  const stepOf = (l: TicketLeg) =>
    t.legs.find((x) => x.kind === 'step' && x.walletId === l.walletId);
  /** Native paid by a wallet: a funded curve buy paid it in its first step. */
  const paidBy = (l: TicketLeg) =>
    BigInt((t.kind === 'buy' ? stepOf(l)?.amountIn : undefined) ?? l.amountIn ?? '0');
  /** What a wallet got: a funded curve sell got native back in its last step. */
  const outBy = (l: TicketLeg) =>
    (t.kind === 'sell' ? stepOf(l)?.amountOut : undefined) ?? l.amountOut;
  const amountOf = (l: TicketLeg) =>
    !l.amountIn
      ? ''
      : t.kind === 'sell'
        ? `${formatToken(BigInt(l.amountIn), decimals)} ${sym}`
        : `${formatCompact(nat(paidBy(l)))} ${unit}`;
  const first = swaps[0];
  const inFlight = swaps.filter((l) => l.status === 'submitted');
  const confirmed = swaps.filter((l) => l.status === 'confirmed');

  // ── working: one row per wallet, its speed as it lands ─────────────────────
  if (t.status === 'working' || inFlight.length > 0) {
    return (
      <article class="toast live" {...hoverProps}>
        <div class="t-head">
          <span class="t-pulse" />
          <strong>
            {DOING[t.kind]}
            {t.kind === 'buy' || t.kind === 'sell' ? ` ${sym}` : ''}
          </strong>
          {first && (
            <span class="t-meta">
              {swaps.length > 1
                ? `${swaps.length} wallets · ${amountOf(first)} each`
                : `${first.walletName} · ${amountOf(first)}`}
            </span>
          )}
        </div>
        <div class="t-legs">
          {t.legs.map((l, i) => (
            <div key={i} class="t-leg">
              <div class="t-leg-top">
                <span class="t-who">
                  {l.note ?? (l.kind === 'approve' ? 'Approve' : l.walletName)}
                </span>
                {legState(l)}
              </div>
              {l.phases && (l.status === 'submitted' || l.status === 'confirmed') && (
                <SpeedStrip phases={l.phases} />
              )}
              {l.waitingNonce !== undefined ? (
                <div class="t-stuck">
                  <span>
                    Queued behind nonce {l.waitingNonce}, which never reached the network.
                  </span>
                  <button
                    type="button"
                    class="btn"
                    title="Send an empty transaction at that nonce so this one goes through"
                    onClick={trusted(() => onReplace(t.id, l.walletId, 'unstick'))}
                  >
                    Unstick
                  </button>
                </div>
              ) : (
                l.error && <span class="t-err">{l.error}</span>
              )}
            </div>
          ))}
        </div>
        {/* Solana has no nonce to replace: a transaction lands or expires. */}
        {inFlight.length > 0 && !isSolana(t.chainId) && (
          <div class="t-acts">
            <button
              type="button"
              class="btn"
              onClick={trusted(() =>
                inFlight.forEach((l) => onReplace(t.id, l.walletId, 'speedUp')),
              )}
            >
              Speed up
            </button>
            <button
              type="button"
              class="btn t-ghost"
              onClick={trusted(() =>
                inFlight.forEach((l) => onReplace(t.id, l.walletId, 'cancel')),
              )}
            >
              Cancel
            </button>
          </div>
        )}
      </article>
    );
  }

  // ── failed or blocked: what happened, and nothing was spent ────────────────
  if (confirmed.length === 0) {
    const err = swaps.find((l) => l.error)?.error ?? t.legs.find((l) => l.error)?.error;
    return (
      <article class="toast bad" {...hoverProps}>
        <div class="t-head">
          <strong>
            {DONE[t.kind]} {t.status === 'blocked' ? 'blocked' : 'not sent'}
          </strong>
          {first && (
            <span class="t-meta">
              {swaps.length > 1 ? `${swaps.length} wallets` : first.walletName}
              {amountOf(first) && ` · ${amountOf(first)}`}
            </span>
          )}
          {dismiss}
        </div>
        {err && <p class="t-msg">{err}</p>}
        {err && (
          <div class="t-acts">
            <button type="button" class="btn t-ghost" onClick={copyDetails(err)}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        )}
        {timer}
      </article>
    );
  }

  // ── confirmed (all or some wallets) ─────────────────────────────────────────
  const outRaw = confirmed.reduce((s, l) => s + BigInt(outBy(l) ?? '0'), 0n);
  const outKnown = confirmed.every((l) => outBy(l) !== undefined);
  const paid = confirmed.reduce((s, l) => s + paidBy(l), 0n);
  const confirmMs = Math.max(...confirmed.map((l) => (l.sentMs ?? 0) + (l.confirmMs ?? 0)));
  const timed = confirmed.find((l) => l.phases);
  const ready = timed && readyMs(timed);
  const usd = (wei: bigint) =>
    t.nativeUsd !== undefined ? ` (${formatUsd(nat(wei) * t.nativeUsd)})` : '';
  let big: string | null = null;
  let line: string | null = null;
  if (t.kind === 'buy') {
    big = outKnown ? `+${formatToken(outRaw, decimals)} ${sym}` : null;
    line = `Paid ${formatCompact(nat(paid))} ${unit}${usd(paid)}`;
  } else if (t.kind === 'sell') {
    big = outKnown ? `+${formatCompact(nat(outRaw))} ${unit}` : null;
    line = `Sold ${formatToken(paid, decimals)} ${sym}${outKnown ? usd(outRaw) : ''}`;
  }
  if (line && t.route) line += ` · ${t.route}`;
  const failed = swaps.filter((l) => l.status === 'failed' || l.status === 'skipped');
  // A funded sell that went through but whose step back to native did not: the token it
  // paid stays in the wallet.
  const unconverted = t.legs.filter(
    (l) =>
      l.kind === 'step' &&
      (l.status === 'failed' || l.status === 'skipped') &&
      confirmed.some((c) => c.walletId === l.walletId),
  );
  // A Solana leg carries its signature in place of a hash; both open at /tx/.
  const hash = confirmed.map((l) => l.hash ?? l.sig).find(Boolean);

  return (
    <article
      class={`toast ${failed.length > 0 || unconverted.length > 0 ? 'warn' : 'ok'}`}
      {...hoverProps}
    >
      <div class="t-head top">
        <div class="t-sum">
          <span class="t-done">
            {failed.length > 0
              ? `${confirmed.length} of ${swaps.length} wallets confirmed`
              : confirmMs > 0
                ? `Confirmed in ${formatDuration(confirmMs)}`
                : 'Confirmed'}
          </span>
          <span class="t-big">{big ?? `${DONE[t.kind]} confirmed`}</span>
          {line && <span class="t-line">{line}</span>}
        </div>
        {dismiss}
      </div>
      {timed?.phases && ready !== undefined && (
        <div class="t-speed">
          <div class="t-speed-top">
            <span>Click to ready</span>
            <b>{formatDuration(ready)}</b>
          </div>
          <SpeedStrip phases={timed.phases} />
          <SpeedLegend phases={timed.phases} />
        </div>
      )}
      {failed.map((l, i) => (
        <span key={i} class="t-err">
          {l.walletName}: {l.error ?? 'not sent'}
        </span>
      ))}
      {unconverted.map((l, i) => (
        <span key={`step${i}`} class="t-err">
          {l.walletName}, {l.note}: {l.error ?? 'not sent'}
        </span>
      ))}
      {hash && (
        <a
          class="t-link"
          href={`${t.explorer}/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on explorer
        </a>
      )}
      {timer}
    </article>
  );
}
