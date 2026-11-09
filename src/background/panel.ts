import { formatUnits, parseEther, type Address } from 'viem';
import type { PanelState, QuoteSet, QuoteView, TaxView } from '../shared/panel';
import { costBasis } from '../shared/pnl';
import { fallbackWallet, hasEvm, type EvmAccount } from '../shared/wallet';
import { readBalances } from './balances';
import type { HistoryStore } from './history';
import { readTokenMeta } from './resolve';
import type { AggregatorCheck } from './trade/aggregator-check';
import { chainContext, type EngineDeps, type TradeEngine } from './trade/engine';
import type { PriceService } from './trade/prices';
import { priceImpactBps, type Routed, type Routing } from './trade/routing';
import { totalBuyBps, totalSellBps, type TaxService } from './trade/tax';
import type { Vault } from './vault/vault';

// The background side of the in-page panel: what it shows for a token (wallets, balances,
// chain settings) and its live quotes, refreshed while it is open.

export type PanelDeps = Pick<
  EngineDeps,
  'settings' | 'client' | 'fetchJson' | 'aggregator' | 'now'
> & {
  vault: Vault;
  history: Pick<HistoryStore, 'list'>;
  prices: PriceService;
  routing: Routing;
  tax: TaxService;
  aggregatorCheck?: Pick<AggregatorCheck, 'trusted'>;
  engine: Pick<TradeEngine, 'warm' | 'readHeld' | 'prepareSell'>;
};

/** Wallets the panel trades with: the selected ones, else the primary wallet. */
async function selectedIds(d: PanelDeps): Promise<string[]> {
  const [gs, all] = await Promise.all([d.settings.get(), d.vault.listAccounts()]);
  const accounts = all.filter(hasEvm);
  const visible = accounts.filter((a) => !a.hidden);
  const ids = gs.selectedWalletIds.filter((id) => visible.some((a) => a.id === id));
  if (ids.length > 0) return ids;
  const fallback = fallbackWallet(accounts);
  return fallback ? [fallback.id] : [];
}

/** The panel's settings and, once unlocked, each visible wallet's balances. */
export async function panelState(
  d: PanelDeps,
  chainId: number,
  token: Address,
): Promise<PanelState> {
  const { chain, cs, gs, ctx } = await chainContext(d, chainId);
  const base: PanelState = {
    locked: true,
    wallets: [],
    nativeUsd: null,
    chain: {
      quickBuyAmounts: cs.quickBuyAmounts,
      quickSellBps: cs.quickSellBps,
      slippageBps: cs.slippageBps,
      priority: cs.priority,
      priorityGwei: cs.priorityGwei,
      customPriorityGwei: cs.customPriorityGwei,
      priorityApplies: chain.feeModel === 'eip1559',
      mev: chain.mev.supported
        ? { supported: true, enabled: cs.mevEnabled, configured: !!cs.mevRpc }
        : { supported: false, enabled: false, configured: false, reason: chain.mev.reason },
      maxTaxBps: cs.maxTaxBps,
    },
    global: {
      hotkeysEnabled: gs.hotkeysEnabled,
      multiWalletMode: gs.multiWalletMode,
      groups: gs.walletGroups,
      confirmAboveUsd: gs.confirmAboveUsd,
      maxUsdPerTx: gs.maxUsdPerTx,
      maxUsdPerClick: gs.maxUsdPerClick,
      priceImpactWarnBps: gs.priceImpactWarnBps,
      priceImpactDangerBps: gs.priceImpactDangerBps,
      quoteRefreshMs: gs.quoteRefreshMs,
    },
  };
  if (!(await d.vault.isUnlocked())) return base;
  const accounts = (await d.vault.listAccounts()).filter(
    (a) => hasEvm(a) && !a.hidden,
  ) as EvmAccount[];
  const selected = new Set(await selectedIds(d));
  const [balances, nativeUsd] = await Promise.all([
    readBalances(
      ctx.client,
      token,
      accounts.map((a) => a.address),
    ).catch(() => []),
    Promise.resolve(d.prices.peek(ctx)),
  ]);
  const basis = costBasis(await d.history.list(), chainId, token);
  return {
    ...base,
    locked: false,
    nativeUsd,
    wallets: accounts.map((a, i) => {
      const b = basis.get(a.id);
      return {
        id: a.id,
        name: a.name,
        address: a.address,
        primary: a.primary,
        selected: selected.has(a.id),
        native: (balances[i]?.native ?? 0n).toString(),
        token: (balances[i]?.token ?? 0n).toString(),
        ...(b &&
          b.tokens > 0n && {
            cost: { tokens: b.tokens.toString(), costWei: b.costWei.toString() },
          }),
      };
    }),
  };
}

const decimalsCache = new Map<string, number>();

/**
 * Quotes for the quick amounts, with price impact, the token's USD price and its tax.
 * `walletIds`: the wallets that trade (the website's own choice), else the selected ones.
 */
export async function panelQuotes(
  d: PanelDeps,
  req: {
    chainId: number;
    token: Address;
    buyAmounts: string[];
    sellBps: number[];
    walletIds?: readonly string[] | undefined;
  },
): Promise<QuoteSet> {
  const { ctx } = await chainContext(d, req.chainId);
  const tradingIds = async () => req.walletIds ?? (await selectedIds(d));
  // Keep fee and nonce caches warm while the panel is open (not awaited).
  if (await d.vault.isUnlocked()) {
    void tradingIds()
      .then((ids) => d.engine.warm(req.chainId, ids))
      .catch(() => undefined);
  }
  const key = `${req.chainId}:${req.token.toLowerCase()}`;
  let decimals = decimalsCache.get(key);
  if (decimals === undefined) {
    decimals = (await readTokenMeta(ctx.client, req.token))?.decimals ?? 18;
    decimalsCache.set(key, decimals);
  }

  const buyIn = req.buyAmounts.map((a) => parseEther(a));
  // Each wallet's balance, kept briefly so a sell clicked next skips reading it (ReadAhead).
  let holders: { address: Address; held: bigint }[] = [];
  if (req.sellBps.length > 0 && (await d.vault.isUnlocked())) {
    const accounts = (await d.vault.listAccounts()).filter(hasEvm);
    const ids = new Set(await tradingIds());
    const addrs = accounts.filter((a) => ids.has(a.id)).map((a) => a.address);
    const held = await d.engine.readHeld(ctx, req.token, addrs);
    holders = addrs.flatMap((address, i) => {
      const amount = held[i] ?? 0n;
      return amount > 0n ? [{ address, held: amount }] : [];
    });
  }
  // Sized as the sell sizes it, each wallet's share summed, so the sell finds this route.
  const sellIn =
    holders.length > 0
      ? req.sellBps.map((bps) => holders.reduce((s, h) => s + (h.held * BigInt(bps)) / 10_000n, 0n))
      : [];

  const smallestBuy =
    buyIn.reduce((m, a) => (a > 0n && (m === 0n || a < m) ? a : m), 0n) || parseEther('0.001');
  const buyRef = smallestBuy / 100n || 1n;
  const sellRef = sellIn.length
    ? sellIn.reduce((m, a) => (a > 0n && (m === 0n || a < m) ? a : m), 0n) / 100n || 1n
    : 0n;

  // The reference amount is quoted together with the real ones. The panel asks again every
  // few seconds, so between full rounds only the pools that won are quoted (`refresh`).
  const [buyRoutes, sellRoutes] = await Promise.all([
    d.routing.bestWithRef(ctx, req.token, 'buy', buyRef, buyIn, { refresh: true }),
    sellIn.length
      ? d.routing.bestWithRef(ctx, req.token, 'sell', sellRef, sellIn, { refresh: true })
      : Promise.resolve([]),
  ]);
  // The allowances a sell on these routes reads at the click, read ahead (not awaited).
  const sellRouted = sellRoutes.flatMap((r) => (r.route ? [r.route] : []));
  if (holders.length > 0 && sellRouted.length > 0)
    void d.engine
      .prepareSell(
        ctx,
        req.token,
        sellRouted,
        holders.map((h) => h.address),
      )
      .catch(() => undefined);
  const nativeUsd = d.prices.peek(ctx);

  // A winning aggregator quote gets its fill checked in the background; if it falls short,
  // routing drops it for this token and the next refresh shows Nesty's own pool.
  const viaAggregator = buyRoutes.findIndex((r) => r.route && d.routing.isFallback(r.route.venue));
  const aggregatorRoute = buyRoutes[viaAggregator]?.route;
  if (aggregatorRoute && d.aggregatorCheck) {
    void d.aggregatorCheck
      .trusted(ctx, aggregatorRoute, buyIn[viaAggregator] ?? 0n)
      .catch(() => undefined);
  }

  const view = (
    r: { route: Routed | null; refOut: bigint | null },
    refIn: bigint,
    amountIn: bigint,
  ): QuoteView | null => {
    if (!r.route) return null;
    return {
      amountIn: amountIn.toString(),
      amountOut: r.route.out.toString(),
      priceImpactBps: r.refOut ? priceImpactBps(amountIn, r.route.out, refIn, r.refOut) : null,
      venue: r.route.pool.label,
    };
  };

  const buys = buyRoutes.map((r, i) => view(r, buyRef, buyIn[i] ?? 0n));
  const sells = sellRoutes.map((r, i) => view(r, sellRef, sellIn[i] ?? 0n));

  // Token USD price from the buy reference: buyRef native buys refOut tokens.
  let tokenUsd: number | null = null;
  const firstBuy = buyRoutes.find((r) => r.route && r.refOut);
  if (firstBuy?.refOut && nativeUsd !== null) {
    tokenUsd =
      (Number(formatUnits(buyRef, 18)) / Number(formatUnits(firstBuy.refOut, decimals))) *
      nativeUsd;
  }

  // Tax: measured once per pool in the background (cached); shown from the next refresh.
  let tax: TaxView | null = null;
  let taxUnknown = false;
  const probeAt = buyRoutes.findIndex((r) => r.route);
  const probeRoute = buyRoutes[probeAt]?.route;
  if (probeRoute) {
    const known = d.tax.peek(ctx, probeRoute);
    if (known === undefined) void d.tax.get(ctx, probeRoute, buyIn[probeAt] ?? 0n);
    else if (known)
      tax = {
        buyBps: totalBuyBps(known),
        sellBps: totalSellBps(known),
        sellFails: known.sellFails,
      };
    // Measured and failed (funded curves are never measured, by design).
    else taxUnknown = !probeRoute.venue.funding?.(ctx, probeRoute.pool);
    // A funded curve's asset may tax transfers itself (GIGGLE on BSC): measure it on its leg
    // pool ahead of the click, so the trade's minimums allow for it without waiting.
    const funding = probeRoute.venue.funding?.(ctx, probeRoute.pool);
    const legVenue = funding && d.routing.venue(funding.leg.venueId);
    if (funding && legVenue) {
      const leg = { venue: legVenue, pool: funding.leg, out: 0n };
      const nativeIn = buyIn[probeAt] ?? 0n;
      if (nativeIn > 0n && d.tax.peek(ctx, leg) === undefined)
        void legVenue
          .quote(ctx, funding.leg, 'buy', [nativeIn])
          .then(([out]) => (out ? d.tax.get(ctx, { ...leg, out }, nativeIn) : null))
          .catch(() => null);
    }
  }

  return {
    buys,
    sells: req.sellBps.map((_, i) => sells[i] ?? null),
    tokenUsd,
    venue: probeRoute?.pool.label ?? null,
    idle: probeRoute ? null : await d.routing.whyNone(ctx, req.token),
    tax,
    taxUnknown,
    fetchedAt: d.now(),
  };
}
