import type { ComponentChildren } from 'preact';
import { formatUnits } from 'viem';
import { networkLabel, networkName } from '../../shared/networks';
import {
  formatCompact,
  formatDuration,
  formatPercent,
  formatToken,
  formatUsd,
} from '../../shared/format';
import { readyMs, type TicketLeg } from '../../shared/panel';
import { nativeDecimals } from '../../shared/solana';
import { shortAddress as short } from '../../shared/wallet';
import { useCopy } from '../../ui/components';
import { SPEED_PARTS, SpeedStrip } from '../../ui/SpeedStrip';
import { nativeSym, payUnitOf, statusOf, swapLegs, title, totals, useHistory } from './Activity';
import { IconBack, IconCopy, IconExternal } from './icons';
import { chartUrl, txUrl } from './links';

/** A leg's transaction: its EVM hash, or its Solana signature. */
const txId = (l: TicketLeg): string | undefined => l.hash ?? l.sig;

const LEG_STATUS: Record<TicketLeg['status'], string> = {
  queued: 'Queued',
  sending: 'Signing',
  submitted: 'Sent',
  confirmed: 'Confirmed',
  failed: 'Failed',
  skipped: 'Skipped',
  blocked: 'Blocked',
};

export function when(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function Row({ k, children }: { k: string; children: ComponentChildren }) {
  return (
    <div class="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A card of label / value rows with dividers. */
export function Rows({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <section class="card td-rows" aria-label={label}>
      <dl>{children}</dl>
    </section>
  );
}

export function ActivityDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const items = useHistory();
  const [copied, copy] = useCopy();
  const t = items?.find((x) => x.id === id);

  const header = (name: ComponentChildren, sub?: ComponentChildren, status?: ComponentChildren) => (
    <header class="td-head">
      <button type="button" class="td-back" aria-label="Back to Activity" onClick={onBack}>
        <IconBack size={15} />
      </button>
      <div class="td-title">
        <span class="td-name">{name}</span>
        {sub && <span class="td-when">{sub}</span>}
      </div>
      {status}
    </header>
  );
  if (items === null) return header('Loading…');
  if (!t) return header('Not found', 'This entry is no longer in your history.');

  const st = statusOf(t);
  const unit = payUnitOf(t);
  const sym = unit.symbol;
  const tokenAddr = t.token ?? t.mint;
  const nat = (raw: bigint) => Number(formatUnits(raw, unit.decimals));
  const usdOf = (wei: bigint) =>
    t.nativeUsd !== undefined ? formatUsd(nat(wei) * t.nativeUsd) : null;
  const native = (wei: bigint) => {
    const usd = usdOf(wei);
    return `${formatCompact(nat(wei))} ${sym}${usd ? ` · ${usd}` : ''}`;
  };
  const tokens = (raw: bigint) =>
    t.decimals !== undefined ? `${formatToken(raw, t.decimals)} ${t.symbol ?? ''}` : null;

  const swaps = swapLegs(t);
  const { paid, out } = totals(t);
  const isTrade = t.kind === 'buy' || t.kind === 'sell';
  const nativeSide = t.kind === 'buy' ? paid : out;
  const tokenSide = t.kind === 'buy' ? out : paid;
  // USD per token, from the native side and the token side of the same trade.
  const price =
    isTrade && nativeSide !== null && tokenSide && t.decimals !== undefined && t.nativeUsd
      ? (nat(nativeSide) * t.nativeUsd) / Number(formatUnits(tokenSide, t.decimals))
      : null;

  const sentMs = swaps.find((l) => l.sentMs !== undefined)?.sentMs;
  const timed = swaps.find((l) => l.phases);
  const phases = timed?.phases;
  const ready = timed && readyMs(timed);
  const confirmMs = swaps.find((l) => l.confirmMs !== undefined)?.confirmMs;
  const fees = t.legs.filter((l) => l.feeWei !== undefined);
  const feeTotal = fees.reduce((sum, l) => sum + BigInt(l.feeWei ?? '0'), 0n);
  const set = t.settings;

  // The headline: what came in, and what it cost.
  let big: string | null = null;
  let forWhat: string | null = null;
  if (t.kind === 'buy') {
    big = out !== null ? tokens(out) : null;
    forWhat = `${big ? 'for ' : 'Paying '}${native(paid)}`;
  } else if (t.kind === 'sell') {
    big = out !== null ? `${formatCompact(nat(out))} ${sym}` : null;
    const sold = tokens(paid);
    const usd = out !== null ? usdOf(out) : null;
    forWhat = [sold && `${big ? 'for ' : 'Selling '}${sold}`, usd].filter(Boolean).join(' · ');
  }
  if (forWhat && price !== null && Number.isFinite(price)) forWhat += ` · ${formatUsd(price)} each`;

  return (
    <div class="stack td">
      {header(
        <>
          {title(t)}
          {t.kind !== 'bridge' && <span class="td-chain">{networkLabel(t.chainId)}</span>}
        </>,
        when(t.createdAt),
        <span class={`td-status ${st.cls}`}>{st.text}</span>,
      )}

      {isTrade && (
        <section class="card td-sum" aria-label="Summary">
          {big && <span class="td-big">+{big}</span>}
          {forWhat && <span class="td-for">{forWhat}</span>}
        </section>
      )}

      {t.kind === 'bridge' && t.bridge && (
        <Rows label="Summary">
          <Row k="Sent">{native(BigInt(t.bridge.amountIn))}</Row>
          <Row k="Received">
            {formatCompact(
              Number(formatUnits(BigInt(t.bridge.amountOut), nativeDecimals(t.bridge.toChainId))),
            )}{' '}
            {nativeSym(t.bridge.toChainId)} on {networkName(t.bridge.toChainId)}
          </Row>
          <Row k="To">{t.bridge.recipientName}</Row>
        </Rows>
      )}

      {t.kind === 'send' && t.recipient && (
        <Rows label="Summary">
          <Row k="Sent">{tokenAddr ? (tokens(paid) ?? '—') : native(paid)}</Row>
          <Row k="To">
            <button
              type="button"
              class="td-copy"
              title={copied === t.recipient ? 'Copied' : 'Copy address'}
              onClick={() => void copy(t.recipient as string)}
            >
              {short(t.recipient)} <IconCopy size={12} />
            </button>
          </Row>
        </Rows>
      )}

      {(t.kind === 'distribute' || t.kind === 'collect') && (
        <Rows label="Summary">
          <Row k={t.kind === 'distribute' ? 'Sent' : 'Collected'}>{native(paid)}</Row>
          <Row k="Wallets">{swaps.length}</Row>
        </Rows>
      )}

      {(sentMs !== undefined || confirmMs !== undefined) && (
        <section class="card td-speed" aria-label="Speed">
          <div class="td-speed-top">
            {/* Nesty's own part first; the network's is outside its control. */}
            <div class="td-ready">
              <span>{phases && ready !== undefined ? 'Click to ready' : 'Click to sent'}</span>
              <b>{formatDuration(ready ?? sentMs ?? 0)}</b>
            </div>
            <div class="td-net">
              {phases && (
                <span>
                  Network accepted <b>{formatDuration(phases.sendMs)}</b>
                </span>
              )}
              {confirmMs !== undefined && (
                <span>
                  Confirmed after <b>{formatDuration(confirmMs)}</b>
                </span>
              )}
            </div>
          </div>
          {phases && (
            <>
              <SpeedStrip phases={phases} />
              <dl class="td-parts">
                {SPEED_PARTS.map((part) => (
                  <div key={part.key}>
                    <dt>
                      <i style={{ background: part.color }} />
                      {part.label}
                    </dt>
                    <dd>{formatDuration(phases[part.key])}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>
      )}

      {(t.route || set || fees.length > 0) && (
        <Rows label="Route and costs">
          {t.route && <Row k="Pool">{t.route}</Row>}
          {set && <Row k="Slippage">{formatPercent(set.slippageBps)}</Row>}
          {set?.priority && (
            <Row k="Priority">
              {set.priority.level[0]?.toUpperCase()}
              {set.priority.level.slice(1)} · {set.priority.gwei} gwei
            </Row>
          )}
          {set?.prioritySol && (
            <Row k="Priority">
              {set.prioritySol.level[0]?.toUpperCase()}
              {set.prioritySol.level.slice(1)} · {set.prioritySol.sol} SOL
            </Row>
          )}
          {set?.mev !== undefined && <Row k="MEV protection">{set.mev ? 'On' : 'Off'}</Row>}
          {fees.length > 0 && <Row k="Network fee">{native(feeTotal)}</Row>}
          {isTrade && <Row k="Platform fee">None</Row>}
        </Rows>
      )}

      <section class="td-txs" aria-label="Transactions">
        <h2 class="section-title">{t.legs.length > 1 ? 'Transactions' : 'Transaction'}</h2>
        {t.legs.map((l, i) => {
          const ms = readyMs(l) ?? l.sentMs;
          return (
            <div key={i} class="td-tx">
              <span class={`td-dot s-${l.status}`} title={LEG_STATUS[l.status]} />
              <span class="td-tx-main">
                <span class="td-tx-name">
                  {l.note ??
                    (l.kind === 'approve' ? 'Approve for selling' : `${l.walletName} · ${t.kind}`)}
                </span>
                {txId(l) ? (
                  <button
                    type="button"
                    class="td-copy"
                    title={copied === txId(l) ? 'Copied' : 'Copy transaction id'}
                    onClick={() => void copy(txId(l) as string)}
                  >
                    {copied === txId(l) ? 'Copied' : short(txId(l) as string)}
                  </button>
                ) : (
                  <span class="td-tx-st">{LEG_STATUS[l.status]}</span>
                )}
                {l.error && <span class="leg-err">{l.error}</span>}
              </span>
              {ms !== undefined && (
                <span
                  class={`td-ms${l.kind === 'approve' ? '' : ' hot'}`}
                  title={readyMs(l) !== undefined ? 'Click to ready' : 'Click to sent'}
                >
                  {formatDuration(ms)}
                </span>
              )}
              {txId(l) && (
                <a
                  class="td-ext"
                  href={txUrl(t.chainId, txId(l) as string)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View on explorer"
                >
                  <IconExternal size={13} />
                </a>
              )}
            </div>
          );
        })}
        {t.bridge?.outHash && (
          <div class="td-tx">
            <span class="td-dot s-confirmed" />
            <span class="td-tx-main">
              <span class="td-tx-name">Received on {networkName(t.bridge.toChainId)}</span>
              <span class="td-tx-st">{short(t.bridge.outHash)}</span>
            </span>
            <a
              class="td-ext"
              href={txUrl(t.bridge.toChainId, t.bridge.outHash)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View on explorer"
            >
              <IconExternal size={13} />
            </a>
          </div>
        )}
      </section>

      {tokenAddr && isTrade && (
        <div class="td-actions">
          <a
            class="btn btn--primary"
            href={chartUrl(t.chainId, tokenAddr)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open chart
          </a>
          <button type="button" class="btn" onClick={() => void copy(tokenAddr)}>
            {copied === tokenAddr ? 'Copied' : 'Copy token address'}
          </button>
        </div>
      )}
    </div>
  );
}
