import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatUnits, type Address } from 'viem';
import {
  formatCompact,
  formatPercent,
  formatTiny,
  formatToken,
  formatUsd,
} from '../../shared/format';
import type { Portfolio } from '../../shared/messages';
import { networkLabel, networkName, tokenUrl } from '../../shared/networks';
import type { PanelState, QuoteSet } from '../../shared/panel';
import { isSolana, nativeDecimals } from '../../shared/solana';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { useCopy } from '../../ui/components';
import { panelApi, refOf } from '../../ui/target';
import { nativeSym, statusOf, title, useHistory } from './Activity';
import { Row, Rows, when } from './ActivityDetail';
import { heldBy, pnlOf, signedUsd, valueOf } from './holdings';
import { ExitPlan } from '../../ui/ExitPlan';
import { IconBack, IconCopy, IconExternal, IconSend, IconShare } from './icons';
import { chartUrl } from './links';
import { TokenAvatar } from './TokenAvatar';

/** The latest trades shown here; the rest are in Activity. */
const TRADES_SHOWN = 5;

/** Prices of meme coins run to many zeros: those get the subscript form. */
const priceText = (usd: number) => (usd < 0.01 ? `$${formatTiny(usd)}` : formatUsd(usd));

type Pending =
  { kind: 'buy'; amount: string; usd: string } | { kind: 'sell'; bps: number; usd: string };

/**
 * One token: what the wallets hold of it, trading it, its market and its history.
 * A token the user never bought or added is locked: nothing here acts on it until they
 * say it is theirs, because such airdrops are the usual bait for scams.
 */
export function TokenDetail({
  chainId,
  token,
  accounts,
  walletIds,
  onBack,
  onSend,
  onOpenTicket,
  onAllTrades,
}: {
  chainId: number;
  token: string;
  accounts: WalletAccount[];
  /** The wallets the wallet page was showing: one, or every listed one. */
  walletIds: string[];
  onBack: () => void;
  onSend: (walletId: string, token: string) => void;
  onOpenTicket: (id: string) => void;
  /** Every trade, in Activity (on this chain). */
  onAllTrades: () => void;
}) {
  // Solana mints are case-sensitive and trade by mint.
  const sol = isSolana(chainId);
  const ref = refOf(chainId, token);
  const sameToken = (a: string | undefined) =>
    a !== undefined && (sol ? a === token : a.toLowerCase() === token.toLowerCase());
  const native = nativeSym(chainId);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const history = useHistory();

  const load = useCallback(async () => {
    const r = await send({ type: 'portfolio.get', chainId, walletIds });
    if (r.ok) setPortfolio(r.data);
    else setMsg(errorText(r));
  }, [chainId, walletIds.join()]);

  useEffect(() => {
    void load();
    // Solana's supply comes with the portfolio (read with the mint).
    if (!sol)
      void send({ type: 'token.supply', chainId, token: token as Address }).then(
        (r) => r.ok && r.data !== null && setSupply(BigInt(r.data)),
      );
    void panelApi.state(ref).then(async (r) => {
      if (!r.ok) return;
      setState(r.data);
      const q = await panelApi.quotes(ref, r.data.chain.quickBuyAmounts.slice(0, 4), [10_000]);
      if (q.ok) setQuotes(q.data);
    });
  }, [load]);

  const t = portfolio?.tokens.find((x) => sameToken(x.address));
  useEffect(() => {
    if (t?.supply) setSupply(BigInt(t.supply));
  }, [t?.supply]);
  const symbol = t?.symbol ?? '…';
  const locked = !!t?.unsolicited;
  const amount = t ? heldBy(t, walletIds) : 0n;
  const value = t ? valueOf(t, amount) : null;
  const pnl =
    t && amount > 0n
      ? pnlOf(t, walletIds, portfolio?.nativeUsd ?? null, nativeDecimals(chainId))
      : null;
  const holders = t ? walletIds.filter((id) => BigInt(t.perWallet[id] ?? '0') > 0n) : [];
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Wallet';
  const mode = state?.global.multiWalletMode ?? 'each';
  const usd = quotes?.tokenUsd ?? null;
  const mcap =
    usd !== null && supply !== null && t ? usd * Number(formatUnits(supply, t.decimals)) : null;
  const exitImpact = amount > 0n ? (quotes?.sells[0]?.priceImpactBps ?? null) : null;
  const trades = (history ?? []).filter(
    (h) => h.chainId === chainId && sameToken(sol ? h.mint : h.token),
  );

  const buy = async (amt: string, confirmed = false) => {
    setMsg(null);
    setBusy(true);
    const r = await panelApi.buy(ref, {
      amount: amt,
      walletIds,
      mode,
      confirmed,
      clickedAt: Date.now(),
    });
    setBusy(false);
    if (r.ok) onOpenTicket(r.data.id);
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'buy', amount: amt, usd: r.detail ?? '' });
    else setMsg(errorText(r));
  };

  const sell = async (bps: number, confirmed = false) => {
    if (holders.length === 0) return;
    setMsg(null);
    setBusy(true);
    const r = await panelApi.sell(ref, {
      bps,
      walletIds: holders,
      confirmed,
      clickedAt: Date.now(),
    });
    setBusy(false);
    if (r.ok) onOpenTicket(r.data.id);
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'sell', bps, usd: r.detail ?? '' });
    else setMsg(errorText(r));
  };

  /** The PnL card of what these wallets hold: the figures of the open-PnL line. */
  const sharePnl = async () => {
    if (!t?.valueUsd) return;
    const total = Number(formatUnits(BigInt(t.total), t.decimals));
    // A Solana coin bought with a token cost that token, as the line counts it.
    const unitUsd = t.costUnit ? t.costUnit.usd : (portfolio?.nativeUsd ?? null);
    if (!unitUsd || total <= 0) return;
    const whole = supply === null ? 0 : Number(formatUnits(supply, t.decimals));
    const r = await send({
      type: 'share.open',
      chainId,
      token: t.address,
      symbol: (t.symbol || 'Token').slice(0, 64),
      decimals: t.decimals,
      unit: {
        symbol: (t.costUnit?.symbol ?? native).slice(0, 16),
        decimals: t.costUnit?.decimals ?? nativeDecimals(chainId),
        mint: t.costUnit?.mint ?? null,
        usd: unitUsd,
      },
      wallets: walletIds.map((id) => {
        const cost = t.cost?.[id];
        return { id, token: t.perWallet[id] ?? '0', ...(cost && { cost }) };
      }),
      tokenUsd: t.valueUsd / total,
      ...(whole > 0 && whole <= 1e21 && { supply: whole }),
    });
    if (!r.ok) setMsg(errorText(r));
  };

  const setTrusted = async (trusted: boolean) => {
    const r = sol
      ? await send({ type: 'sol.portfolio.setTrusted', mint: token, trusted })
      : await send({ type: 'portfolio.setTrusted', chainId, token: token as Address, trusted });
    if (!r.ok) return setMsg(errorText(r));
    if (trusted) await load();
    else onBack();
  };

  const header = (
    <header class="td-head">
      <button type="button" class="td-back" aria-label="Back to Wallets" onClick={onBack}>
        <IconBack size={15} />
      </button>
      <TokenAvatar chainId={chainId} token={token} symbol={symbol} />
      <div class="td-title">
        <span class="td-name">
          {symbol}
          <span class="td-chain">{networkLabel(chainId)}</span>
        </span>
        <span class="td-when">{t?.name ?? shortAddress(token)}</span>
      </div>
      {locked && <span class="td-status bad">Not bought</span>}
    </header>
  );

  if (portfolio === null)
    return (
      <div class="stack td" aria-busy="true">
        {header}
        <section class="card td-sum">
          <span class="skel skel--big" />
          <span class="skel skel--line" />
        </section>
        <span class="skel tkd-skel" />
        <span class="skel tkd-skel" />
      </div>
    );
  if (!t)
    return (
      <div class="stack td">
        {header}
        <p class="notice">
          None of your wallets hold this token on {networkName(chainId)} any more.
        </p>
      </div>
    );

  const walletsText =
    walletIds.length === 1
      ? `with ${nameOf(walletIds[0] ?? '')}`
      : mode === 'each'
        ? `in each of ${walletIds.length} wallets`
        : `split across ${walletIds.length} wallets`;

  return (
    <div class="stack td tkd">
      {header}

      {locked && (
        <div class="notice notice--danger tkd-lock" role="note">
          <p>
            You never bought this token: it was sent to you. Unrequested tokens are often scams, and
            their name, price and links can be faked. Trading, sending and links are off.
          </p>
          <button type="button" class="btn btn--sm" onClick={() => void setTrusted(true)}>
            It's mine, show it
          </button>
        </div>
      )}

      <section class="card td-sum" aria-label="Your position">
        <span class="td-big">
          {formatToken(amount, t.decimals)} {t.symbol}
        </span>
        <span class="td-for">
          {locked
            ? 'Value hidden: its price can be faked'
            : value !== null
              ? `Worth ${formatUsd(value)}`
              : 'No price yet'}
          {pnl && ` · cost ${formatUsd(pnl.costUsd)}`}
        </span>
        {pnl && (
          <button
            type="button"
            class={`pnl-line ${pnl.usd >= 0 ? 'up' : 'down'}`}
            title="Share as a card"
            onClick={() => void sharePnl()}
          >
            {signedUsd(pnl.usd)} ({pnl.bps >= 0 ? '+' : '−'}
            {formatPercent(Math.abs(pnl.bps))}) open PnL
            <span class="share-tag">
              <IconShare size={11} />
              Share
            </span>
          </button>
        )}
      </section>

      {/* Disabled as a whole for a token the user never bought. */}
      <fieldset class="card tkd-trade" disabled={locked || busy || !state || state.locked}>
        <div class="tkd-side">
          <span class="tkd-label buy">Buy</span>
          <span class="tkd-hint">{walletsText}</span>
        </div>
        <div class="tkd-keys">
          {(state?.chain.quickBuyAmounts ?? []).slice(0, 4).map((a, i) => (
            <button
              key={a}
              type="button"
              class="tkd-key buy"
              title={
                quotes?.buys[i]
                  ? `About ${formatToken(BigInt(quotes.buys[i].amountOut), t.decimals)} ${t.symbol}`
                  : undefined
              }
              onClick={() => void buy(a)}
            >
              {a} <small>{native}</small>
            </button>
          ))}
        </div>
        <div class="tkd-side">
          <span class="tkd-label sell">Sell</span>
          <span class="tkd-hint">
            {holders.length === 0
              ? 'Nothing to sell here'
              : `from ${holders.length === 1 ? nameOf(holders[0] ?? '') : `${holders.length} wallets`}`}
          </span>
        </div>
        <div class="tkd-keys">
          {(state?.chain.quickSellBps ?? [2_500, 5_000, 10_000]).slice(0, 4).map((bps) => (
            <button
              key={bps}
              type="button"
              class="tkd-key sell"
              disabled={holders.length === 0}
              onClick={() => void sell(bps)}
            >
              {formatPercent(bps)}
            </button>
          ))}
        </div>
        <div class="tkd-more">
          <button
            type="button"
            class="btn btn--sm"
            disabled={holders.length === 0}
            onClick={() => onSend(holders[0] ?? '', t.address)}
          >
            <IconSend size={14} /> Send
          </button>
          {locked ? (
            <button type="button" class="btn btn--sm" disabled>
              <IconExternal size={13} /> Chart
            </button>
          ) : (
            <a
              class="btn btn--sm"
              href={chartUrl(chainId, t.address)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <IconExternal size={13} /> Chart
            </a>
          )}
        </div>
      </fieldset>

      {pending && (
        <div class="notice notice--warn" role="alertdialog">
          {pending.kind === 'buy'
            ? `Buy ${pending.amount} ${native} ${walletsText} (about ${pending.usd})?`
            : `Sell ${formatPercent(pending.bps)} (about ${pending.usd})?`}
          <span class="row" style={{ marginTop: '6px' }}>
            <button type="button" class="btn btn--sm" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={() => {
                const p = pending;
                setPending(null);
                void (p.kind === 'buy' ? buy(p.amount, true) : sell(p.bps, true));
              }}
            >
              Confirm
            </button>
          </span>
        </div>
      )}
      {msg && (
        <p class="hint" role="status">
          {msg}
        </p>
      )}

      {t && !locked && (
        <ExitPlan
          key={`${chainId}:${t.address}`}
          chainId={chainId}
          token={t.address}
          walletIds={holders.length > 0 ? holders : walletIds}
          canSet={amount > 0n}
        />
      )}

      {holders.length > 1 && (
        <Rows label="Per wallet">
          {holders.map((id) => {
            const raw = BigInt(t.perWallet[id] ?? '0');
            const v = valueOf(t, raw);
            return (
              <Row key={id} k={nameOf(id)}>
                {formatToken(raw, t.decimals)}
                {v !== null && <small> · {formatUsd(v)}</small>}
              </Row>
            );
          })}
        </Rows>
      )}

      <h2 class="section-title">Market</h2>
      <Rows label="Market">
        <Row k="Price">{usd !== null ? priceText(usd) : quotes ? '–' : <Skel />}</Row>
        <Row k="Market cap">{mcap !== null ? formatUsd(mcap) : quotes ? '–' : <Skel />}</Row>
        {!sol && (
          <Row k="Tax">
            {quotes?.tax ? (
              `Buy ${formatPercent(quotes.tax.buyBps)} · Sell ${
                quotes.tax.sellFails
                  ? 'fails'
                  : quotes.tax.sellBps !== null
                    ? formatPercent(quotes.tax.sellBps)
                    : '?'
              }`
            ) : quotes ? (
              'Not measured'
            ) : (
              <Skel />
            )}
          </Row>
        )}
        <Row k="Route">{quotes ? (quotes.venue ?? 'No pool found') : <Skel />}</Row>
        {amount > 0n && (
          <Row k="Selling all">
            {exitImpact !== null ? (
              `${formatPercent(exitImpact)} price impact`
            ) : quotes ? (
              '–'
            ) : (
              <Skel />
            )}
          </Row>
        )}
      </Rows>

      <h2 class="section-title">Your trades</h2>
      {history === null ? (
        <span class="skel tkd-skel" />
      ) : trades.length === 0 ? (
        <p class="hint">No trades of {t.symbol} through Nesty yet.</p>
      ) : (
        <div class="td-txs">
          {trades.slice(0, TRADES_SHOWN).map((h) => {
            const st = statusOf(h);
            return (
              <button
                key={h.id}
                type="button"
                class="td-tx tkd-tx"
                onClick={() => onOpenTicket(h.id)}
              >
                <span class="td-tx-main">
                  <span class="td-tx-name">{title(h)}</span>
                  <span class="td-tx-st">{when(h.createdAt)}</span>
                </span>
                <span class={`td-status ${st.cls}`}>{st.text}</span>
              </button>
            );
          })}
          {trades.length > TRADES_SHOWN && (
            <button type="button" class="link tkd-all" onClick={onAllTrades}>
              See all {trades.length} in Activity
            </button>
          )}
        </div>
      )}

      <h2 class="section-title">Token</h2>
      <Rows label="Token">
        <Row k={sol ? 'Mint' : 'Contract'}>
          {locked ? (
            shortAddress(t.address)
          ) : (
            <button
              type="button"
              class="td-copy"
              title={copied === t.address ? 'Copied' : 'Copy address'}
              onClick={() => void copy(t.address)}
            >
              {shortAddress(t.address)} <IconCopy size={12} />
            </button>
          )}
        </Row>
        <Row k="Decimals">{t.decimals}</Row>
        <Row k="Total supply">
          {supply !== null ? formatCompact(Number(formatUnits(supply, t.decimals))) : '–'}
        </Row>
        {!locked && (
          <Row k="Explorer">
            <a
              class="td-copy"
              href={tokenUrl(chainId, t.address)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open <IconExternal size={12} />
            </a>
          </Row>
        )}
      </Rows>

      <button
        type="button"
        class="btn btn--ghost tkd-hide"
        disabled={locked}
        onClick={() => void setTrusted(false)}
      >
        Hide this token
      </button>
    </div>
  );
}

function Skel() {
  return <span class="skel skel--val" />;
}
