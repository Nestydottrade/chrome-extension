import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatUnits, parseUnits } from 'viem';
import { browser } from 'wxt/browser';
import type { Detection, ResolvedTarget } from '../../shared/detection';
import {
  formatCompact,
  formatPercent,
  formatTiny,
  formatToken,
  formatUsd,
  parseDecimalInput,
} from '../../shared/format';
import type { PushEvent } from '../../shared/messages';
import { initialsShare, unrealisedPnl } from '../../shared/pnl';
import {
  readyMs,
  type BlockedAction,
  type PanelState,
  type QuoteSet,
  type QuoteView,
  type TaxView,
  type TradeTicket,
} from '../../shared/panel';
import { MAX_WALLET_GROUPS, type WalletGroup } from '../../shared/settings/defaults';
import { shortAddress } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { PANEL_GAP, PANEL_WIDTH, toastPlacement } from './layout';
import { clamp, isEditable, trusted, useDrag, useHotkeys, usePanelPrefs } from './hooks';
import { NestMark } from '../../ui/NestMark';
import { ExitPlan } from '../../ui/ExitPlan';
import { Toasts, type ReplaceMode, type ToastItem } from './Toasts';
import { networkOf, panelApi, tokenId, type SavedTradePatch } from '../../ui/target';
import {
  ArrowIcon,
  BoltIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  ExpandIcon,
  MinusIcon,
  RouteIcon,
} from './icons';
import {
  PenIcon,
  QuickValuesEditor,
  TradeSettings,
  isSellPercent,
  type TradePatch,
} from './TradeSettings';

const SELL_KEYS = ['q', 'w', 'e', 'r'];

const REPLACE_FAILED: Record<ReplaceMode, string> = {
  speedUp: 'Speed-up not sent',
  cancel: 'Cancel not sent',
  unstick: 'Unstick not sent',
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
/** RPC keep-alive cadence, and how long it continues once the tab is hidden. */
const WARM_EVERY_MS = 20_000;
const WARM_HIDDEN_MAX_MS = 10 * 60_000;
const LOCKED_RECHECK_MS = 2_000;

type Pending =
  { kind: 'buy'; amount: string; usd: string } | { kind: 'sell'; bps: number; usd: string };

/** "· Tax 5% / 5%" in the status bar; red when over Max tax or the sell fails. */
function TaxBadge({ tax, maxBps }: { tax: TaxView; maxBps: number }) {
  // To a hundredth, as launchpads set them (1.25%) and the website shows them.
  const pct = (bps: number) => formatPercent(bps, 2);
  if (tax.sellFails)
    return (
      <span
        class="imp-bad"
        title="A simulated sell of this token reverted. You may not be able to sell."
      >
        Sell fails
      </span>
    );
  const worst = Math.max(tax.buyBps, tax.sellBps ?? 0);
  if (worst === 0 && tax.sellBps !== null) return null;
  const tone = maxBps < 10_000 && worst > maxBps ? 'imp-bad' : worst > 0 ? 'imp-warn' : '';
  return (
    <span
      class={tone}
      title={`Token tax from a simulated buy and sell: ${pct(tax.buyBps)} on buys, ${tax.sellBps === null ? 'unknown' : pct(tax.sellBps)} on sells. Pool fees are not included.`}
    >
      Tax {pct(tax.buyBps)} / {tax.sellBps === null ? '?' : pct(tax.sellBps)}
    </span>
  );
}

/**
 * Protection as it really is: private only when it is on AND a private RPC is set;
 * otherwise sends go to the public mempool, which the user must see. Chains without a
 * public mempool show nothing.
 */
function MevStatus({ mev }: { mev: PanelState['chain']['mev'] }) {
  if (!mev.supported) return null;
  if (mev.enabled && mev.configured)
    return <span title="Sent through your private RPC">Private</span>;
  return (
    <span
      class="imp-warn"
      title="Transactions go to the public mempool and can be sandwiched. Turn on MEV protection (and set a private RPC) in Settings → Chains."
    >
      Public mempool
    </span>
  );
}

/** Placeholders in the panel's shape while the token and balances load. */
function PanelSkeleton({ label }: { label: string }) {
  return (
    <div class="body" aria-busy="true" aria-label={label}>
      <div class="pos">
        <span class="skel w40" />
        <span class="skel big w50" />
        <span class="skel w80" />
      </div>
      <div class="opts">
        <span class="skel box" />
        <span class="skel box" />
      </div>
      <div class="grid">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} class="skel key" />
        ))}
      </div>
    </div>
  );
}

export function Panel({ detection }: { detection: Detection | null }) {
  const [target, setTarget] = useState<ResolvedTarget | null | 'loading'>('loading');
  const [state, setState] = useState<PanelState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [quoteErr, setQuoteErr] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [picker, setPicker] = useState(false);
  /** Balances are being read again for the wallet list; shown as placeholders until then. */
  const [refreshing, setRefreshing] = useState(false);
  /** The selection changed and its balances are being read; the old figures would mislead. */
  const [switching, setSwitching] = useState(false);
  const switchSeq = useRef(0);
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [blocked, setBlocked] = useState<BlockedAction[] | null>(null);
  /** Which button is waiting for the background ("buy:0.01", "sell:5000"). */
  const [busy, setBusy] = useState<string | null>(null);
  const [editingAmounts, setEditingAmounts] = useState(false);
  const [editingSells, setEditingSells] = useState(false);
  /** Click-to-ready of the last send on this page, shown in the footer. */
  const [lastReady, setLastReady] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [prefs, setPrefs] = usePanelPrefs();
  const drag = useDrag((x, y) => setPrefs({ x, y }));
  // Re-place (and re-clamp) the panel and its toasts when the window is resized.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const retries = useRef(new Map<string, () => void>());
  const typingInPanel = useRef(false);
  const quoteTick = useRef<(() => void) | null>(null);
  const chainIdRef = useRef<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── resolve the token from the URL ────────────────────────────────────────
  useEffect(() => {
    setQuotes(null);
    setState(null);
    if (!detection) {
      setTarget(null);
      return;
    }
    setTarget('loading');
    let alive = true;
    void send({ type: 'panel.resolve', detection }).then(
      (r) => alive && setTarget(r.ok ? r.data : null),
    );
    return () => {
      alive = false;
    };
  }, [detection?.address, detection?.poolId, detection?.solana, detection?.chainId]);

  const t = target && target !== 'loading' ? target : null;
  const net = t ? networkOf(t) : null;
  const tokenAddr = t ? tokenId(t) : null;
  chainIdRef.current = t?.chainId ?? null;
  // A Solana coin bought with a token (USDC, say) is priced and paid in that token.
  const native = state?.pay?.symbol ?? net?.native ?? 'ETH';
  const nd = state?.pay?.decimals ?? net?.nativeDecimals ?? 18;
  const isSol = t?.kind === 'solana';

  const loadState = useCallback(async () => {
    if (!t) return;
    const r = await panelApi.state(t);
    if (r.ok) setState(r.data);
  }, [t?.chainId, tokenAddr]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  // ── quotes: prefetch on open, refresh while the tab is visible ────────────
  const maxSellBps = Math.max(...(state?.chain.quickSellBps ?? [10_000]));
  const holding = useMemo(
    () =>
      (state?.wallets ?? []).filter((w) => w.selected).reduce((s, w) => s + BigInt(w.token), 0n),
    [state],
  );
  useEffect(() => {
    // Locked: nothing to quote for (no buttons), and the token stays private until unlocked.
    if (!t || !state || state.locked || prefs.hidden) return;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await panelApi.quotes(
        t,
        state.chain.quickBuyAmounts,
        !state.locked && holding > 0n ? state.chain.quickSellBps : [],
      );
      if (!alive) return;
      if (r.ok) {
        setQuotes(r.data);
        setQuoteErr(false);
      } else setQuoteErr(true);
    };
    let last = 0;
    quoteTick.current = () => {
      // Block events can arrive several times a second on L2s; refresh at most ~1/s.
      if (Date.now() - last < 900) return;
      last = Date.now();
      void tick();
    };
    void tick();
    const id = setInterval(tick, state.global.quoteRefreshMs);
    return () => {
      alive = false;
      quoteTick.current = null;
      clearInterval(id);
    };
  }, [
    t?.chainId,
    tokenAddr,
    state?.chain.quickBuyAmounts.join(),
    state?.chain.quickSellBps.join(),
    state?.locked,
    holding > 0n,
    prefs.hidden,
  ]);

  // ── RPC keep-alive: a click right after a pause should not wait for a new TLS
  // handshake. Runs while visible and for a while after the tab is hidden.
  const chainId = t?.chainId;
  const locked = state?.locked ?? true;
  useEffect(() => {
    if (chainId === undefined || locked || prefs.hidden) return;
    let seenAt = Date.now();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') seenAt = Date.now();
      else if (Date.now() - seenAt > WARM_HIDDEN_MAX_MS) return;
      void panelApi.warm(chainId);
    }, WARM_EVERY_MS);
    return () => clearInterval(id);
  }, [chainId, locked, prefs.hidden]);

  // ── locked: look again now and then. The unlock push can miss this tab (a worker
  // restart loses which tabs have a panel), and the unlock frame cannot tell the panel.
  useEffect(() => {
    if (!locked || prefs.hidden) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadState();
    }, LOCKED_RECHECK_MS);
    return () => clearInterval(id);
  }, [locked, prefs.hidden, loadState]);

  // ── wallet list: close on any click outside it (selection is saved on each toggle) ──
  useEffect(() => {
    if (!picker) return;
    const host = (sectionRef.current?.getRootNode() as ShadowRoot | undefined)?.host;
    // Clicks inside the closed shadow root reach the page retargeted to the host;
    // those are judged by the panel's own handler below.
    const onPage = (e: PointerEvent) => {
      if (e.target !== host) setPicker(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicker(false);
    };
    window.addEventListener('pointerdown', onPage, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPage, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [picker]);

  // ── push events from the background ──────────────────────────────────────
  useEffect(() => {
    const onMsg = (msg: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = msg as PushEvent;
      if (ev?.kind === 'nesty.vault') void loadState();
      // New block (WebSocket RPC): refresh quotes right away instead of waiting.
      if (ev?.kind === 'nesty.block' && ev.chainId === chainIdRef.current) quoteTick.current?.();
      if (ev?.kind === 'nesty.ticket') {
        upsertTicket(ev.ticket);
        if (ev.ticket.legs.some((l) => l.status === 'confirmed')) void loadState();
        if (ev.ticket.blocked) setBlocked(ev.ticket.blocked);
      }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [loadState]);

  const upsertTicket = (ticket: TradeTicket) => {
    const ready = ticket.legs.map(readyMs).filter((v): v is number => v !== undefined);
    if (ready.length > 0) setLastReady(Math.min(...ready));
    setToasts((prev) => {
      const others = prev.filter((x) => x.id !== ticket.id);
      return [{ id: ticket.id, ticket }, ...others].slice(0, 4);
    });
  };
  const pushError = (text: string, retry?: () => void, title = 'Trade not sent') => {
    const id = crypto.randomUUID();
    if (retry) retries.current.set(id, retry);
    setToasts((prev) =>
      [{ id, error: text, title, ...(retry ? { retry: true } : {}) }, ...prev].slice(0, 4),
    );
  };

  // ── actions ───────────────────────────────────────────────────────────────
  const selectedIds = (state?.wallets ?? []).filter((w) => w.selected).map((w) => w.id);

  const buy = async (amount: string, confirmed = false) => {
    if (!t || !state || state.locked || selectedIds.length === 0) return;
    const clickedAt = Date.now();
    setBlocked(null);
    setBusy(`buy:${amount}`);
    const r = await panelApi.buy(t, {
      amount,
      walletIds: selectedIds,
      mode: state.global.multiWalletMode,
      confirmed,
      clickedAt,
    });
    setBusy(null);
    if (r.ok) upsertTicket(r.data);
    else if (r.error === 'locked') void loadState();
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'buy', amount, usd: r.detail ?? '' });
    else pushError(errorText(r), () => void buy(amount, confirmed));
  };

  const sell = async (bps: number, confirmed = false) => {
    if (!t || !state || state.locked || selectedIds.length === 0) return;
    const clickedAt = Date.now();
    setBlocked(null);
    setBusy(`sell:${bps}`);
    const r = await panelApi.sell(t, { bps, walletIds: selectedIds, confirmed, clickedAt });
    setBusy(null);
    if (r.ok) upsertTicket(r.data);
    else if (r.error === 'locked') void loadState();
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'sell', bps, usd: r.detail ?? '' });
    else pushError(errorText(r), () => void sell(bps, confirmed));
  };

  const replace = async (ticketId: string, walletId: string, mode: ReplaceMode) => {
    const type = `trade.${mode}` as const;
    const r = await send<typeof type>({ type, ticketId, walletId });
    if (r.ok) upsertTicket(r.data);
    else pushError(errorText(r), undefined, REPLACE_FAILED[mode]);
  };

  // Optimistic: update the UI immediately, persist in the background, resync on failure.
  const setTrade = async (patch: TradePatch, saved: SavedTradePatch = patch) => {
    if (!t || !state) return;
    const { mevEnabled, ...rest } = patch;
    setState({
      ...state,
      chain: {
        ...state.chain,
        ...rest,
        mev:
          mevEnabled === undefined ? state.chain.mev : { ...state.chain.mev, enabled: mevEnabled },
      },
    });
    const r = await panelApi.setTrade(t, saved);
    if (!r.ok) {
      pushError(errorText(r), undefined, 'Setting not saved');
      await loadState();
    }
  };

  const setMultiWallet = async (mode: 'each' | 'split') => {
    if (!state || state.global.multiWalletMode === mode) return;
    setState({ ...state, global: { ...state.global, multiWalletMode: mode } });
    const r = await send({ type: 'panel.setMultiWallet', mode });
    if (!r.ok) {
      pushError(errorText(r), undefined, 'Setting not saved');
      await loadState();
    }
  };

  const setSelection = async (ids: string[]) => {
    if (!state || ids.length === 0) return;
    setState({
      ...state,
      wallets: state.wallets.map((w) => ({ ...w, selected: ids.includes(w.id) })),
    });
    // Only the latest switch clears the placeholders.
    const seq = ++switchSeq.current;
    setSwitching(true);
    try {
      await send({ type: 'panel.selectWallets', walletIds: ids });
      await loadState();
    } finally {
      if (seq === switchSeq.current) setSwitching(false);
    }
  };
  const toggleWallet = (id: string) =>
    void setSelection(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  /** Switch to one wallet: the quick way to change who trades. */
  const soloWallet = (id: string) => {
    setPicker(false);
    void setSelection([id]);
  };

  // ── wallet groups ─────────────────────────────────────────────────────────
  const visibleIds = (state?.wallets ?? []).map((w) => w.id);
  const groups = state?.global.groups ?? [];
  /** A group's wallets that are still listed (removed or hidden ones drop out). */
  const groupIds = (g: WalletGroup) => g.walletIds.filter((id) => visibleIds.includes(id));
  const activeGroup = groups.find((g) => sameSet(groupIds(g), selectedIds));
  const useGroup = (g: WalletGroup) => {
    const ids = groupIds(g);
    if (ids.length === 0) return;
    setPicker(false);
    if (g.mode) void setMultiWallet(g.mode);
    void setSelection(ids);
  };
  /** Name being typed for "Save as group", or null when not saving. */
  const [naming, setNaming] = useState<string | null>(null);
  /** The PnL card of what the picked wallets hold: the figures the pill shows. */
  const sharePnl = async () => {
    if (!t || !state?.nativeUsd || !quotes?.tokenUsd) return;
    const r = await send({
      type: 'share.open',
      chainId: t.chainId,
      token: tokenId(t),
      symbol: (t.symbol || 'Token').slice(0, 64),
      decimals: t.decimals,
      unit: {
        symbol: native.slice(0, 16),
        decimals: nd,
        mint: state.pay?.mint ?? null,
        usd: state.nativeUsd,
      },
      wallets: state.wallets
        .filter((w) => w.selected)
        .map((w) => ({ id: w.id, token: w.token, ...(w.cost && { cost: w.cost }) })),
      tokenUsd: quotes.tokenUsd,
    });
    if (!r.ok) pushError(errorText(r), undefined, 'Card not opened');
  };
  const saveGroup = async () => {
    const name = naming?.trim();
    if (!name || selectedIds.length === 0) return;
    const r = await send({ type: 'panel.saveGroup', name, walletIds: selectedIds });
    if (!r.ok) return pushError(errorText(r), undefined, 'Group not saved');
    setNaming(null);
    await loadState();
  };

  // Alt + 1–9 switches to that group. Only switches wallets: it never trades.
  useEffect(() => {
    if (!state || state.locked || prefs.hidden || prefs.minimized || groups.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.repeat || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditable(e.composedPath()[0])) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      const g = n ? groups[Number(n) - 1] : undefined;
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      useGroup(g);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, prefs.hidden, prefs.minimized]);

  useHotkeys(
    !!state && !state.locked && state.global.hotkeysEnabled && !prefs.minimized && !prefs.hidden,
    (k) => {
      const i = ['1', '2', '3', '4'].indexOf(k);
      const amount = state?.chain.quickBuyAmounts[i];
      if (i >= 0 && amount) void buy(amount);
      const s = SELL_KEYS.indexOf(k);
      const bps = state?.chain.quickSellBps[s];
      if (s >= 0 && bps && holding > 0n) void sell(bps);
    },
    () => typingInPanel.current,
  );

  // ── render ───────────────────────────────────────────────────────────────
  if (target === null && !detection) return null;
  if (prefs.hidden) {
    return (
      <button
        type="button"
        class="k chip"
        style={{ right: '16px', bottom: '16px', width: 'auto' }}
        onClick={trusted(() => setPrefs({ hidden: false }))}
      >
        <span class="brand">
          <NestMark size={16} />
          Nesty
        </span>
      </button>
    );
  }

  const x =
    prefs.x < 0
      ? window.innerWidth - PANEL_WIDTH - PANEL_GAP
      : clamp(prefs.x, 0, window.innerWidth - PANEL_WIDTH);
  const y = prefs.y < 0 ? 80 : clamp(prefs.y, 0, window.innerHeight - 40);
  const pos = drag.live ?? { x, y };

  const quoteSub = (q: QuoteView | null | undefined, side: 'buy' | 'sell') => {
    if (!q) return quotes ? 'no route' : '…';
    const out =
      side === 'buy'
        ? `${formatToken(BigInt(q.amountOut), t?.decimals ?? 18)}`
        : `${formatTiny(Number(formatUnits(BigInt(q.amountOut), nd)))} ${native}`;
    return out;
  };
  // The impact bar fills up as the impact nears the danger threshold.
  const meterWidth = (bps: number | null | undefined) =>
    bps === null || bps === undefined || !state
      ? '0%'
      : `${Math.min(100, Math.max(4, (bps / Math.max(state.global.priceImpactDangerBps, 1)) * 100))}%`;
  const impactCls = (bps: number | null | undefined) =>
    bps === null || bps === undefined || !state
      ? 'faint'
      : bps >= state.global.priceImpactDangerBps
        ? 'imp-bad'
        : bps >= state.global.priceImpactWarnBps
          ? 'imp-warn'
          : 'imp-ok';

  const selectedCount = selectedIds.length;
  const customAmount = parseDecimalInput(custom);
  const summaryAmount = customAmount ?? state?.chain.quickBuyAmounts[0] ?? '0';
  const perWallet = (() => {
    try {
      const a = parseUnits(summaryAmount, nd);
      return state?.global.multiWalletMode === 'split' && selectedCount > 0
        ? a / BigInt(selectedCount)
        : a;
    } catch {
      return 0n;
    }
  })();
  const totalWei = perWallet * BigInt(Math.max(selectedCount, 1));
  const totalUsd = state?.nativeUsd ? Number(formatUnits(totalWei, nd)) * state.nativeUsd : null;
  const holdingUsd =
    quotes?.tokenUsd && t ? Number(formatUnits(holding, t.decimals)) * quotes.tokenUsd : null;
  // Of the tokens bought through Nesty and still held: value now against what they cost.
  const pnl =
    t && state
      ? unrealisedPnl(
          state.wallets.filter((w) => w.selected),
          t.decimals,
          quotes?.tokenUsd ?? null,
          state.nativeUsd,
          nd,
        )
      : null;
  // Sell initials: the share of the holding worth what these tokens cost.
  const initials =
    t && state
      ? initialsShare(
          state.wallets.filter((w) => w.selected),
          t.decimals,
          quotes?.tokenUsd ?? null,
          state.nativeUsd,
          nd,
        )
      : null;
  const nativeBal = (state?.wallets ?? [])
    .filter((w) => w.selected)
    .reduce((s, w) => s + BigInt(w.native), 0n);
  const disabled = !state || state.locked || selectedCount === 0;
  const holderIds = (state?.wallets ?? []).filter((w) => BigInt(w.token) > 0n).map((w) => w.id);
  const walletUsd = (raw: bigint) =>
    quotes?.tokenUsd && t ? Number(formatUnits(raw, t.decimals)) * quotes.tokenUsd : null;

  const header = (
    <div class="head" {...drag.handlers}>
      <span class="mark">
        <NestMark size={26} />
      </span>
      <span class="id">
        <span class="id-top">
          {t ? (
            <span class="sym" title={t.name}>
              {t.symbol}
            </span>
          ) : (
            <span class="brand">Nesty</span>
          )}
          {net && <span class="chain">{net.label}</span>}
        </span>
        {t && net && tokenAddr && (
          // The contract address is what is actually traded; let the user check it.
          <span class="addr-row">
            <a
              class="addr"
              href={net.tokenUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${t.name} — ${tokenAddr}`}
            >
              {shortAddress(tokenAddr)}
            </a>
            <button
              type="button"
              class="copy"
              aria-label={copied ? 'Copied' : 'Copy token address'}
              title={copied ? 'Copied' : 'Copy token address'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={trusted(() => {
                void navigator.clipboard.writeText(tokenAddr).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1_200);
                });
              })}
            >
              {copied ? '✓' : <CopyIcon />}
            </button>
          </span>
        )}
      </span>
      <button
        type="button"
        class="ib"
        aria-label={prefs.minimized ? 'Expand' : 'Minimize'}
        onClick={trusted(() => setPrefs({ minimized: !prefs.minimized }))}
      >
        {prefs.minimized ? <ExpandIcon /> : <MinusIcon />}
      </button>
      <button
        type="button"
        class="ib"
        aria-label="Hide panel"
        onClick={trusted(() => setPrefs({ hidden: true }))}
      >
        <CloseIcon />
      </button>
    </div>
  );

  let body;
  if (target === 'loading') {
    body = <PanelSkeleton label="Detecting token" />;
  } else if (!t) {
    body = (
      <div class="body">
        <div class="card warn">
          <strong>Token not detected</strong>
          <span class="muted">This page does not point to a token on a supported chain.</span>
        </div>
      </div>
    );
  } else if (!state) {
    body = <PanelSkeleton label="Loading" />;
  } else if (state.locked) {
    body = (
      <div class="body">
        <span class="muted">
          Unlock Nesty to trade. Your password is typed into an extension frame the page cannot
          read.
        </span>
        <iframe
          class="unlock-frame"
          title="Unlock Nesty"
          src={browser.runtime.getURL('/unlock.html')}
        />
      </div>
    );
  } else if (prefs.minimized) {
    body = (
      <div class="mini" key="mini">
        {state.chain.quickBuyAmounts.slice(0, 2).map((a, i) => (
          <button
            key={i}
            type="button"
            class="tb buy"
            disabled={disabled}
            onClick={trusted(() => void buy(a))}
            aria-busy={busy === `buy:${a}`}
          >
            <span class="main">
              {a} {native}
            </span>
          </button>
        ))}
        <button
          type="button"
          class="tb sell"
          disabled={disabled || holding === 0n}
          onClick={trusted(() => void sell(maxSellBps))}
          aria-busy={busy === `sell:${maxSellBps}`}
        >
          <span class="main">Sell {formatPercent(maxSellBps)}</span>
        </button>
      </div>
    );
  } else {
    body = (
      <div class="body" key="full">
        <div class="pos" role="group" aria-label="Your position" ref={pickerRef}>
          <div class="pos-top">
            <span class="muted">Your position</span>
            <button
              type="button"
              class="chip"
              aria-expanded={picker}
              aria-label="Choose wallets"
              onClick={trusted(() => {
                if (picker) return setPicker(false);
                setPicker(true);
                setRefreshing(true);
                void loadState().finally(() => setRefreshing(false));
              })}
            >
              <span class="chip-dot" />
              {selectedCount} wallet{selectedCount === 1 ? '' : 's'}
              <ChevronIcon />
            </button>
          </div>

          {/* Saved groups: one tap (or Alt + its number) picks who trades. */}
          {groups.length > 0 && (
            <div class="gchips" role="group" aria-label="Wallet groups">
              {groups.map((g, i) => {
                const n = groupIds(g).length;
                return (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={activeGroup?.id === g.id}
                    disabled={n === 0}
                    title={`${g.name}: ${n} wallet${n === 1 ? '' : 's'} · Alt + ${i + 1}`}
                    onClick={trusted(() => useGroup(g))}
                  >
                    <span>{g.name}</span>
                    <small>{n}</small>
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={!activeGroup && selectedCount === visibleIds.length}
                onClick={trusted(() => {
                  setPicker(false);
                  void setSelection(visibleIds);
                })}
              >
                <span>All</span>
                <small>{visibleIds.length}</small>
              </button>
              {!activeGroup && selectedCount !== visibleIds.length && (
                <span class="gcustom" title="The current pick matches no saved group">
                  Custom · {selectedCount}
                </span>
              )}
            </div>
          )}

          {/* Few wallets: one tap switches. Ctrl or Shift adds one to the selection. */}
          {groups.length === 0 && state.wallets.length >= 2 && state.wallets.length <= 4 && (
            <div class="wchips" role="group" aria-label="Trade with">
              {state.wallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  aria-pressed={w.selected}
                  title={`Trade with ${w.name} only. Ctrl or Shift + click to add it.`}
                  onClick={trusted((e: MouseEvent) =>
                    e.ctrlKey || e.metaKey || e.shiftKey ? toggleWallet(w.id) : soloWallet(w.id),
                  )}
                >
                  {BigInt(w.token) > 0n && <i class="hold-dot" title={`Holds ${t.symbol}`} />}
                  <span>{w.name}</span>
                </button>
              ))}
            </div>
          )}

          {picker && (
            <div class="picker" role="group" aria-label="Wallets">
              <div class="pk-head">
                <button
                  type="button"
                  class="pk-q"
                  onClick={trusted(() => {
                    setPicker(false);
                    void setSelection(state.wallets.map((w) => w.id));
                  })}
                >
                  All
                </button>
                <button
                  type="button"
                  class="pk-q"
                  disabled={refreshing || holderIds.length === 0}
                  title={`Every wallet that holds ${t.symbol}`}
                  onClick={trusted(() => {
                    setPicker(false);
                    void setSelection(holderIds);
                  })}
                >
                  Holders · {refreshing ? '…' : holderIds.length}
                </button>
                <span class="sp" />
                <span class="faint">Ctrl + click to pick several</span>
              </div>
              <div class="wgrid">
                {state.wallets.map((w) => {
                  const held = BigInt(w.token);
                  const usd = held > 0n ? walletUsd(held) : null;
                  return (
                    <div
                      key={w.id}
                      class={`wcard${held > 0n && !refreshing ? ' holds' : ''}${w.selected ? ' on' : ''}`}
                    >
                      <button
                        type="button"
                        class="wsolo"
                        aria-pressed={w.selected}
                        title={`Trade with ${w.name} only. Ctrl or Shift + click to add it.`}
                        onClick={trusted((e: MouseEvent) =>
                          e.ctrlKey || e.metaKey || e.shiftKey
                            ? toggleWallet(w.id)
                            : soloWallet(w.id),
                        )}
                      >
                        <i class="wtick" aria-hidden="true" />
                        <span class="wname" title={w.address}>
                          {w.name}
                        </span>
                        {refreshing ? (
                          <>
                            <span class="skel w70" />
                            <span class="skel w50" />
                          </>
                        ) : (
                          <>
                            <span class="whold">
                              {held > 0n
                                ? `${formatToken(held, t.decimals)} ${t.symbol}`
                                : `No ${t.symbol}`}
                            </span>
                            <small>
                              {usd !== null && `${formatUsd(usd)} · `}
                              {formatToken(BigInt(w.native), nd)} {native}
                            </small>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div class="pk-foot">
                {naming === null ? (
                  <>
                    <span class="faint">
                      {activeGroup ? `Group: ${activeGroup.name}` : `${selectedCount} selected`}
                    </span>
                    <span class="sp" />
                    {!activeGroup && groups.length < MAX_WALLET_GROUPS && (
                      <button type="button" class="pk-save" onClick={trusted(() => setNaming(''))}>
                        Save as group
                      </button>
                    )}
                  </>
                ) : (
                  <form
                    class="pk-name"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveGroup();
                    }}
                  >
                    <input
                      autoFocus
                      maxLength={24}
                      placeholder="Sniper"
                      aria-label="Group name"
                      value={naming}
                      onInput={(e) => setNaming(e.currentTarget.value)}
                      onFocus={() => (typingInPanel.current = true)}
                      onBlur={() => (typingInPanel.current = false)}
                    />
                    <button type="button" class="pk-q" onClick={trusted(() => setNaming(null))}>
                      Cancel
                    </button>
                    <button type="submit" class="pk-q on" disabled={!naming.trim()}>
                      Save
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {switching ? (
            <>
              <span class="skel big w50" />
              <span class="skel w80" />
            </>
          ) : (
            <>
              <div class="pos-main">
                <span class="pos-amt">
                  <span class="big">{holding > 0n ? formatToken(holding, t.decimals) : '0'}</span>
                  <span class="muted">{t.symbol}</span>
                </span>
                {holding > 0n && pnl && (
                  <button
                    type="button"
                    class={`pnl ${pnl.usd >= 0 ? 'up' : 'down'}`}
                    title="Unrealised PnL of the tokens bought through Nesty, gas not included. Click to share it as a card."
                    onClick={trusted(() => void sharePnl())}
                  >
                    <span class="pnl-usd">
                      {pnl.usd >= 0 ? '+' : '−'}
                      {formatUsd(Math.abs(pnl.usd))}
                    </span>
                    <span class="pnl-pct">
                      <ArrowIcon up={pnl.bps >= 0} />
                      {formatPercent(Math.abs(pnl.bps))}
                    </span>
                  </button>
                )}
              </div>
              <div class="pos-foot">
                <span>
                  {holding === 0n
                    ? 'No position yet'
                    : holdingUsd !== null
                      ? `Worth ${formatUsd(holdingUsd)}${pnl ? ` · cost ${formatUsd(pnl.costUsd)}` : ''}`
                      : 'Holding'}
                </span>
                <span>
                  {formatToken(nativeBal, nd)} {native} free
                </span>
              </div>
            </>
          )}
        </div>

        {!switching && (
          <ExitPlan
            key={`${t.chainId}:${t.kind === 'solana' ? t.mint : t.token}`}
            chainId={t.chainId}
            token={t.kind === 'solana' ? t.mint : t.token}
            walletIds={selectedIds}
            canSet={holding > 0n}
          />
        )}

        <TradeSettings
          chain={state.chain}
          // A token tax is an EVM thing: pump.fun coins are plain SPL tokens.
          showTax={!isSol}
          settingsPath={isSol ? 'Settings → Chains → Solana' : 'Settings → Chains'}
          onChange={(patch) => void setTrade(patch)}
        />

        <div class="side">
          <div class="side-head">
            <h2 class="buy">Buy</h2>
            <span class="sp" />
            {selectedCount > 1 && (
              // With several wallets: is the amount bought in each, or shared between them?
              <span class="mw" role="group" aria-label="Amount with several wallets">
                <button
                  type="button"
                  aria-pressed={state.global.multiWalletMode === 'each'}
                  title={`The amount is bought in each of the ${selectedCount} wallets`}
                  onClick={trusted(() => void setMultiWallet('each'))}
                >
                  ×{selectedCount} each
                </button>
                <button
                  type="button"
                  aria-pressed={state.global.multiWalletMode === 'split'}
                  title={`The amount is split between the ${selectedCount} wallets`}
                  onClick={trusted(() => void setMultiWallet('split'))}
                >
                  ÷{selectedCount} split
                </button>
              </span>
            )}
            {/* Bought with a token at its price, the amounts follow the USD ones in Settings. */}
            {(!state.pay || state.pay.stable) && (
              <button
                type="button"
                class="edit"
                aria-label="Edit quick-buy amounts"
                title="Edit quick-buy amounts"
                aria-pressed={editingAmounts}
                onClick={trusted(() => setEditingAmounts(!editingAmounts))}
              >
                <PenIcon />
                Edit
              </button>
            )}
          </div>
          {editingAmounts && (!state.pay || state.pay.stable) ? (
            <QuickValuesEditor
              values={state.chain.quickBuyAmounts}
              unit={native}
              what="Quick-buy amount"
              columns={2}
              // Dollar amounts are kept to the cent.
              validate={(n) => n > 0 && (!state.pay || Number.isInteger(Math.round(n * 1e6) / 1e4))}
              onCancel={() => setEditingAmounts(false)}
              onSave={(amounts) => {
                setEditingAmounts(false);
                // A dollar stablecoin shows the USD amounts themselves: those are what change.
                void setTrade(
                  { quickBuyAmounts: amounts },
                  state.pay ? { quickBuyUsd: amounts } : { quickBuyAmounts: amounts },
                );
              }}
            />
          ) : state.pay && state.chain.quickBuyAmounts.length === 0 ? (
            <p class="note">
              No USD price for {state.pay.symbol}, so buys cannot be checked against your limits.
            </p>
          ) : (
            <div class="grid">
              {state.chain.quickBuyAmounts.map((a, i) => {
                const q = quotes?.buys[i];
                return (
                  <button
                    key={i}
                    type="button"
                    class="tb buy"
                    disabled={disabled}
                    onClick={trusted(() => void buy(a))}
                    aria-busy={busy === `buy:${a}`}
                    aria-label={`Buy ${a} ${native}`}
                  >
                    <span class="tb-top">
                      <span class="main">
                        {a}
                        <small>{native}</small>
                      </span>
                      <kbd>{i + 1}</kbd>
                    </span>
                    <span class="sub">
                      {busy === `buy:${a}` ? (
                        'Sending…'
                      ) : !quotes && !quoteErr ? (
                        <span class="skel w70" />
                      ) : q ? (
                        `≈ ${quoteSub(q, 'buy')} ${t.symbol}`
                      ) : (
                        quoteSub(q, 'buy')
                      )}
                    </span>
                    <span class="meter-row" title="Price impact">
                      <span class={`meter ${impactCls(q?.priceImpactBps)}`}>
                        <span style={{ width: meterWidth(q?.priceImpactBps) }} />
                      </span>
                      <span class={`imp-txt ${impactCls(q?.priceImpactBps)}`}>
                        {q?.priceImpactBps !== undefined && q?.priceImpactBps !== null
                          ? formatPercent(q.priceImpactBps)
                          : '–'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <form
          class="custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (!e.isTrusted) return;
            if (customAmount) void buy(customAmount);
          }}
        >
          <label class="amt">
            <input
              aria-label={`Custom amount in ${native}`}
              placeholder="Amount"
              inputMode="decimal"
              value={custom}
              onInput={(e) => setCustom(e.currentTarget.value)}
            />
            <span class="unit">{native}</span>
          </label>
          <button type="submit" class="btn buy big" disabled={disabled || !customAmount}>
            Buy
          </button>
        </form>

        {selectedCount > 1 && (
          <div class="summary">
            {formatCompact(Number(formatUnits(perWallet, nd)))} {native} per wallet ×{' '}
            {selectedCount} = {formatCompact(Number(formatUnits(totalWei, nd)))} {native}
            {totalUsd !== null && <span class="muted"> ≈ {formatUsd(totalUsd)}</span>}
            <span class="faint">
              {' '}
              · {state.global.multiWalletMode === 'split' ? 'split total' : 'same per wallet'}
            </span>
          </div>
        )}

        <div class="side">
          <div class="side-head">
            <h2 class="sell">Sell</h2>
            {initials && !editingSells && (
              <button
                type="button"
                class="init"
                disabled={disabled || holding === 0n}
                title={`Sells ${formatPercent(initials.bps)}, worth about what these tokens cost (${formatUsd(initials.costUsd)}). The rest stays.`}
                aria-busy={busy === `sell:${initials.bps}`}
                onClick={trusted(() => void sell(initials.bps))}
              >
                Initials {formatPercent(initials.bps)}
              </button>
            )}
            <button
              type="button"
              class="edit"
              aria-label="Edit quick-sell percentages"
              title="Edit quick-sell percentages"
              aria-pressed={editingSells}
              onClick={trusted(() => setEditingSells(!editingSells))}
            >
              <PenIcon />
              Edit
            </button>
          </div>
          {editingSells ? (
            <QuickValuesEditor
              values={state.chain.quickSellBps.map((b) => String(b / 100))}
              unit="%"
              what="Quick-sell percentage"
              columns={4}
              validate={isSellPercent}
              onCancel={() => setEditingSells(false)}
              onSave={(values) => {
                setEditingSells(false);
                void setTrade({ quickSellBps: values.map((v) => Math.round(Number(v) * 100)) });
              }}
            />
          ) : (
            <div class="sells">
              {state.chain.quickSellBps.map((bps, i) => (
                <button
                  key={i}
                  type="button"
                  class="tb sell"
                  disabled={disabled || holding === 0n}
                  onClick={trusted(() => void sell(bps))}
                  aria-busy={busy === `sell:${bps}`}
                  aria-label={`Sell ${bps / 100}%`}
                >
                  <span class="tb-top">
                    <span class="main">{bps / 100}%</span>
                    <kbd>{(SELL_KEYS[i] ?? '').toUpperCase()}</kbd>
                  </span>
                  <span class="sub">
                    {busy === `sell:${bps}` ? (
                      'Sending…'
                    ) : holding === 0n ? (
                      '–'
                    ) : !quotes && !quoteErr ? (
                      <span class="skel w70" />
                    ) : quotes?.sells[i] ? (
                      `≈ ${quoteSub(quotes.sells[i], 'sell')}`
                    ) : (
                      quoteSub(quotes?.sells[i], 'sell')
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {pending && (
          <div class="card warn" role="alertdialog" aria-label="Confirm trade">
            <strong>
              Confirm{' '}
              {pending.kind === 'buy'
                ? `buy ${pending.amount} ${native}`
                : `sell ${pending.bps / 100}%`}
            </strong>
            <span class="muted">Worth about {pending.usd}, above your confirmation threshold.</span>
            <div class="row">
              <button type="button" class="btn" onClick={trusted(() => setPending(null))}>
                Cancel
              </button>
              <button
                type="button"
                class={`btn ${pending.kind}`}
                onClick={trusted(() => {
                  const p = pending;
                  setPending(null);
                  if (p.kind === 'buy') void buy(p.amount, true);
                  else void sell(p.bps, true);
                })}
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        {blocked && (
          <div class="card danger" role="alert">
            <div class="row">
              <strong>Transaction blocked</strong>
              <span class="sp" />
              <button
                type="button"
                class="ib"
                aria-label="Dismiss"
                onClick={trusted(() => setBlocked(null))}
              >
                ×
              </button>
            </div>
            <span class="muted">Nothing was signed. Decoded actions:</span>
            {blocked.map((a, i) => (
              <div key={i} class="act">
                <span class={a.ok ? 'ok' : 'no'}>{a.ok ? '✓' : '✗'}</span>
                <span>
                  {a.label}
                  {a.reason && <span class="no"> — {a.reason}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const status = (
    <div class="status">
      <span class={`route ${quoteErr ? 'imp-bad' : quotes ? 'on' : ''}`}>
        <RouteIcon />
      </span>
      <span class="venue" title={quotes?.venue ?? quotes?.idle ?? ''}>
        {quoteErr
          ? 'Quote failed'
          : quotes
            ? `${quotes.venue ?? quotes.idle ?? 'No route'}`
            : state?.locked
              ? 'Locked'
              : 'Waiting for quotes'}
      </span>
      <span class="sp" />
      {quotes?.tax && state && <TaxBadge tax={quotes.tax} maxBps={state.chain.maxTaxBps} />}
      {quotes?.taxUnknown && state && (
        <span
          class={state.chain.maxTaxBps < 10_000 ? 'imp-bad' : 'imp-warn'}
          title="The token tax could not be measured (the RPC may not simulate, or only an aggregator trades it). With Max tax on, buys are refused."
        >
          Tax ?
        </span>
      )}
      {state && <MevStatus mev={state.chain.mev} />}
      {lastReady !== null && (
        <span class="ready" title="Click to signed, on your last trade here">
          <BoltIcon />
          Ready in ~{Math.round(lastReady)} ms
        </span>
      )}
    </div>
  );

  return (
    <>
      <section
        class="k"
        ref={sectionRef}
        onPointerDown={(e) => {
          if (picker && !pickerRef.current?.contains(e.target as Node)) setPicker(false);
        }}
        // Ends above the window's bottom edge wherever it sits; the rest scrolls inside.
        style={{
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          maxHeight: `${Math.max(120, window.innerHeight - pos.y - 8)}px`,
        }}
        aria-label="Nesty trading panel"
        // Track focus inside the closed shadow root so hotkeys stay off while typing here.
        onFocusIn={(e) => (typingInPanel.current = isEditable(e.target))}
        onFocusOut={() => (typingInPanel.current = false)}
      >
        {header}
        {body}
        {t && !prefs.minimized && status}
      </section>
      <Toasts
        items={toasts}
        decimals={t?.decimals ?? 18}
        symbol={t?.symbol ?? ''}
        native={native}
        placement={toastPlacement(pos.x, window.innerWidth)}
        onDismiss={(id) => {
          retries.current.delete(id);
          setToasts((p) => p.filter((x) => x.id !== id));
        }}
        onRetry={(id) => {
          retries.current.get(id)?.();
          retries.current.delete(id);
          setToasts((p) => p.filter((x) => x.id !== id));
        }}
        onReplace={replace}
      />
    </>
  );
}
