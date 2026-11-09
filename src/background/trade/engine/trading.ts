import {
  encodeFunctionData,
  formatEther,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import type { ChainConfig } from '../../../shared/chains';
import type { TicketLeg, TradeTicket } from '../../../shared/panel';
import { formatToken } from '../../../shared/format';
import {
  effectivePreset,
  type ChainSettings,
  type GlobalSettings,
  type TradePrefs,
} from '../../../shared/settings/defaults';
import { hasEvm, type EvmAccount } from '../../../shared/wallet';
import { erc20Abi } from '../../chain/abis';
import { buildPermit, readPermit2Allowance } from '../permit2';
import { tokenReceived } from '../receipts';
import type { TradeRef } from '../signer';
import { taxGate, type TaxInfo } from '../tax';
import type { Routed } from '../routing';
import {
  buildTx,
  type Funding,
  type PoolRef,
  type TxDraft,
  type Venue,
  type VenueCtx,
} from '../types';
import {
  ROUTER_NATIVE,
  buildTransferPermit,
  checkTransferPermit,
  encodeRouterExecute,
  legSupported,
  routerBuyCalls,
  routerSellCalls,
  type FundedRoute,
} from '../nesty-router';
import { PERMIT2 } from '../uniswap/addresses';
import { validatePermit } from '../validator';
import {
  type BuyGate,
  type EngineCore,
  type EngineDeps,
  type TicketState,
  TradeError,
  markRefused,
  shortErr,
  sleep,
  walletAmounts,
} from './core';

const DEADLINE_S = 10 * 60;
/** Slippage for converting native into a funding asset (VIRTUAL): a deep pool. */
const FUNDING_SLIPPAGE_BPS = 100;

/**
 * Allowance to grant a sell spender. The spender itself is still limited to Permit2 or an
 * allowlisted router/launchpad by the validator.
 */
export function approvalTarget(gs: GlobalSettings, held: bigint): bigint {
  return gs.unlimitedApprovals
    ? maxUint256
    : (held * BigInt(10_000 + gs.approvalBufferBps)) / 10_000n;
}

/** The pool a route trades on, as a signer that checks the trade finds it again. */
const refOf = (route: { venue: Venue; pool: PoolRef }): TradeRef => ({
  token: route.pool.token,
  venueId: route.venue.id,
  poolId: route.pool.id,
});

/** Minimum output after a known transfer tax and the slippage tolerance. Never 0. */
export function minOutAfter(out: bigint, taxBps: number, slippageBps: number): bigint {
  const afterTax = (out * BigInt(10_000 - Math.min(taxBps, 9_999))) / 10_000n;
  const min = (afterTax * BigInt(10_000 - slippageBps)) / 10_000n;
  return min > 0n ? min : 1n;
}

/** One wallet's buy, as the buy flows receive it. */
interface BuyParams {
  chain: ChainConfig;
  cs: ChainSettings;
  gs: GlobalSettings;
  ctx: VenueCtx;
  wallet: EvmAccount;
  amount: bigint;
  route: Routed;
  own: Address[];
  maxValue: bigint;
}

/** One wallet's sell, as the sell flows receive it. */
interface SellParams {
  chain: ChainConfig;
  cs: ChainSettings;
  gs: GlobalSettings;
  ctx: VenueCtx;
  wallet: EvmAccount;
  amount: bigint;
  balance: bigint;
  route: Routed;
  quotedIn: bigint;
  own: Address[];
  /** The pool the trade is on, when the route is its funding leg (see unfund). */
  ref?: TradeRef;
}

/** Buys and sells from the panel: one leg per wallet, sent in parallel. */
export class TradingFlow {
  private readonly d: EngineDeps;

  constructor(private readonly core: EngineCore) {
    this.d = core.d;
  }

  // ── buy ───────────────────────────────────────────────────────────────────

  async buy(
    req: {
      chainId: number;
      token: Address;
      amount: string;
      walletIds: string[];
      mode: 'each' | 'split';
      confirmed: boolean;
      clickedAt?: number | undefined;
      /** A website trade's own settings, in place of the stored ones. */
      prefs?: TradePrefs | undefined;
      /** Who decides whether the user sees this buy first, in place of `confirmed`. */
      gate?: BuyGate | undefined;
    },
    tabId?: number,
  ): Promise<TradeTicket> {
    let startedAt = this.core.clickTime(req.clickedAt);
    const { chain, cs, gs, ctx } = await this.core.context(req.chainId, req.prefs);
    const wallets = await this.core.wallets(req.walletIds);
    const total = parseEther(req.amount);
    const per = req.mode === 'split' ? total / BigInt(wallets.length) : total;
    if (per <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');
    const clickTotal = per * BigInt(wallets.length);

    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    if (nativeUsd === null)
      throw new TradeError('limit_exceeded', 'USD price unavailable, cannot check limits.');
    const perUsd = Number(formatEther(per)) * nativeUsd;
    const totalUsd = Number(formatEther(clickTotal)) * nativeUsd;
    if (perUsd > gs.maxUsdPerTx)
      throw new TradeError(
        'limit_exceeded',
        `$${perUsd.toFixed(2)} per wallet > $${gs.maxUsdPerTx}.`,
      );
    if (totalUsd > gs.maxUsdPerClick)
      throw new TradeError(
        'limit_exceeded',
        `$${totalUsd.toFixed(2)} total > $${gs.maxUsdPerClick}.`,
      );
    if (req.gate) {
      const spend = `${formatToken(clickTotal, 18)} ${chain.nativeCurrency.symbol}`;
      const coin = this.core.symbolNow(ctx, req.token) ?? null;
      // The time the user took to answer is not the trade's.
      if (await req.gate({ usd: totalUsd, spend, coin })) startedAt = this.d.now();
    } else if (totalUsd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `$${totalUsd.toFixed(2)}`);

    // The panel prefetches quotes for the quick amounts; a fresh one skips a round trip.
    const cachedRoute = this.d.routing.cached(ctx, req.token, 'buy', per, gs.maxQuoteAgeMs);
    let route = cachedRoute ?? (await this.d.routing.best(ctx, req.token, 'buy', [per]))[0];
    if (!route) throw new TradeError('no_route');
    // An aggregator route is used only once its fill has been checked against own pools
    // (normally already done while the panel quoted); otherwise routing drops it.
    if (this.d.aggregatorCheck && !(await this.d.aggregatorCheck.trusted(ctx, route, per)))
      route = (await this.d.routing.best(ctx, req.token, 'buy', [per]))[0] ?? route;
    // The panel measures the tax when it opens, so this is normally a cache hit.
    if (cs.maxTaxBps < 10_000) {
      const measurable = !route.venue.funding?.(ctx, route.pool);
      const refusal = taxGate(await this.d.tax.get(ctx, route, per), cs.maxTaxBps, measurable);
      if (refusal) throw new TradeError('tax_too_high', refusal);
    }
    const symbol = this.core.symbolNow(ctx, req.token);

    const amounts = walletAmounts(per, wallets.length, gs.buyVarianceBps);
    const legs: TicketLeg[] = wallets.map((w, i) => ({
      walletId: w.id,
      walletName: w.name,
      kind: 'swap',
      status: 'queued',
      amountIn: (amounts[i] ?? per).toString(),
    }));
    const st = this.core.newTicket('buy', chain, legs, tabId, req.token, symbol);
    st.startedAt = startedAt;
    this.core.describe(st, ctx, cs, route, nativeUsd);
    if (!symbol) this.core.fillSymbol(st, ctx, req.token);
    const own = (await this.d.vault.listAccounts()).filter(hasEvm).map((a) => a.address);
    const maxValue = this.core.usdToWei(gs.maxUsdPerTx, nativeUsd);

    void (async () => {
      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i] as EvmAccount;
        if (i > 0 && gs.jitterMaxMs > 0) await sleep(Math.floor(Math.random() * gs.jitterMaxMs));
        const amount = amounts[i] ?? per;
        void this.buyOne(st, i, {
          chain,
          cs,
          gs,
          ctx,
          wallet: w,
          amount,
          // The quote is for `per`: a smaller buy is held to its share of it.
          route: amount === per ? route : { ...route, out: (route.out * amount) / per },
          own,
          maxValue,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  private async buyOne(st: TicketState, i: number, p: BuyParams): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const { chain, cs, gs, ctx, wallet, amount, route } = p;
    try {
      const preset = effectivePreset(cs);
      // route.out is at most maxQuoteAgeMs old (prefetched by the panel or quoted on click);
      // slippage covers movement in between, and simulation catches anything worse.
      const out = route.out;
      if (!out) {
        leg.status = 'failed';
        leg.error = 'No quote';
        this.core.update(st);
        return;
      }
      const funding = route.venue.funding?.(ctx, route.pool);
      if (funding) {
        const via = this.viaRouter(chain, ctx, funding);
        await (via ? this.routerBuy(st, i, p, funding, via) : this.fundedBuy(st, i, p, funding));
        return;
      }
      const gate = this.balanceGate(chain, ctx, preset, wallet, amount);
      // A transfer tax is not in the pool quote; without this, any tax above the slippage
      // would make every buy revert.
      const taxBps = this.d.tax.peek(ctx, route)?.transfer.buyBps ?? 0;
      const minOut = minOutAfter(out, taxBps, preset.slippageBps);
      const deadline = BigInt(Math.floor(this.d.now() / 1000) + DEADLINE_S);
      const tx = await buildTx(route.venue, ctx, route.pool, 'buy', {
        wallet: wallet.address,
        amountIn: amount,
        minOut,
        deadline,
      });
      const vctx = this.core.validationCtx(
        chain,
        wallet.address,
        p.own,
        { token: route.pool.token, maxValue: p.maxValue },
        { ctx, venueId: route.venue.id, pool: route.pool },
      );
      const ok = await this.core.execute(st, i, {
        chain,
        cs,
        gs,
        wallet,
        tx,
        vctx,
        kind: 'swap',
        simulate: gs.simulateBeforeSign,
        gate,
        purpose: {
          kind: 'swap',
          ref: refOf(route),
          side: 'buy',
          amountIn: amount,
          minOut,
          deadline,
        },
      });
      if (ok)
        await this.ensureSellApproval(st, {
          chain,
          cs,
          gs,
          ctx,
          wallet,
          pool: route.pool,
          venueId: route.venue.id,
          extra: out,
          own: p.own,
        });
    } catch (e) {
      leg.status = 'failed';
      leg.error = shortErr(e);
      markRefused(st.ticket, leg, e);
      this.core.update(st);
    }
  }

  /**
   * Balance check fetched while the swap is simulated rather than before it (one round
   * trip less), applied to the gas limit that will be signed. Never rejects, so a
   * validator block cannot leave it unhandled.
   */
  private balanceGate(
    chain: ChainConfig,
    ctx: VenueCtx,
    preset: ReturnType<typeof effectivePreset>,
    wallet: EvmAccount,
    amount: bigint,
  ): Promise<(gasLimit: bigint) => string | null> {
    return Promise.all([
      ctx.client.getBalance({ address: wallet.address }),
      this.d.fees.fees(chain, ctx.client, preset, this.d.now()),
    ]).then(
      ([balance, fees]) =>
        (gasLimit: bigint) => {
          const need = amount + gasLimit * fees.maxFeePerGas;
          const sym = chain.nativeCurrency.symbol;
          return balance < need
            ? `Insufficient balance: needs ${formatToken(need, 18)} ${sym} with gas, has ${formatToken(balance, 18)}`
            : null;
        },
      (e: unknown) => () => `Balance check failed: ${shortErr(e)}`,
    );
  }

  /** The Nesty Router for a funded pool, when the chain has one and can trade the leg. */
  private viaRouter(
    chain: ChainConfig,
    ctx: VenueCtx,
    funding: Funding,
  ): { router: Address; legVenue: Venue } | null {
    const router = chain.nestyRouter;
    const legVenue = this.d.routing.venue(funding.leg.venueId);
    if (!router || !legVenue || !legSupported(ctx, legVenue, funding.leg)) return null;
    return { router, legVenue };
  }

  private fundedRoute(
    ctx: VenueCtx,
    wallet: Address,
    route: Routed,
    funding: Funding,
    via: { router: Address; legVenue: Venue },
  ): FundedRoute {
    return {
      ctx,
      router: via.router,
      wallet,
      venue: route.venue,
      pool: route.pool,
      legVenue: via.legVenue,
      leg: funding.leg,
      asset: funding.asset,
      deadline: BigInt(Math.floor(this.d.now() / 1000) + DEADLINE_S),
    };
  }

  /**
   * The funding asset's own transfer tax (GIGGLE on BSC takes one; VIRTUAL, PEPE and USDG
   * do not), measured on its leg pool like any token's and cached. Pool quotes leave it
   * out, so every minimum after the leg allows for it. `nativeIn` buys `assetOut` there.
   */
  private assetTax(
    ctx: VenueCtx,
    legVenue: Venue,
    funding: Funding,
    nativeIn: bigint,
    assetOut: bigint,
  ): Promise<TaxInfo | null> {
    return this.d.tax
      .get(ctx, { venue: legVenue, pool: funding.leg, out: assetOut }, nativeIn)
      .catch(() => null);
  }

  /**
   * Buy on a funded pool in ONE transaction through the Nesty Router: native → asset,
   * approve, curve buy. Sells of the token then go through the router as well, so the
   * approval that follows is for Permit2.
   */
  private async routerBuy(
    st: TicketState,
    i: number,
    p: BuyParams,
    funding: Funding,
    via: { router: Address; legVenue: Venue },
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const { chain, cs, gs, ctx, wallet, amount, route } = p;
    const preset = effectivePreset(cs);
    const gate = this.balanceGate(chain, ctx, preset, wallet, amount);
    const [assetOut] = await via.legVenue.quote(ctx, funding.leg, 'buy', [amount]);
    if (!assetOut) {
      leg.status = 'failed';
      leg.error = `No ${funding.symbol} quote`;
      this.core.update(st);
      return;
    }
    const assetBps =
      (await this.assetTax(ctx, via.legVenue, funding, amount, assetOut))?.transfer.buyBps ?? 0;
    const taxBps = this.d.tax.peek(ctx, route)?.transfer.buyBps ?? 0;
    // The curve is quoted on the asset before its tax: less of it arrives, so less comes out.
    const minOut = minOutAfter(route.out, taxBps + assetBps, preset.slippageBps);
    const r = this.fundedRoute(ctx, wallet.address, route, funding, via);
    const assetMin = minOutAfter(assetOut, assetBps, FUNDING_SLIPPAGE_BPS);
    const calls = routerBuyCalls({ ...r, amountIn: amount, assetMin, minOut });
    const tx: TxDraft = {
      to: via.router,
      data: encodeRouterExecute({
        calls,
        tokenOut: route.pool.token,
        minOut,
        sweep: [funding.asset, chain.wrappedNative],
        deadline: r.deadline,
      }),
      value: amount,
    };
    const vctx = this.core.validationCtx(
      chain,
      wallet.address,
      p.own,
      { token: route.pool.token, fundingAsset: funding.asset, maxValue: p.maxValue },
      { ctx, venueId: route.venue.id, pool: route.pool },
    );
    const ok = await this.core.execute(st, i, {
      chain,
      cs,
      gs,
      wallet,
      tx,
      vctx,
      kind: 'routed',
      // Several venue calls in one: their gas varies too much for a static guess, and
      // nothing is pending that would make the simulation fail for the wrong reason.
      simulate: true,
      gate,
      purpose: {
        kind: 'router',
        ref: refOf(route),
        side: 'buy',
        amountIn: amount,
        assetMin,
        minOut,
        deadline: r.deadline,
      },
    });
    if (ok)
      await this.ensureSellApproval(st, {
        chain,
        cs,
        gs,
        ctx,
        wallet,
        pool: route.pool,
        venueId: route.venue.id,
        extra: route.out,
        own: p.own,
        spender: PERMIT2,
      });
  }

  /**
   * Buy on a pool that trades against an ERC-20 asset (e.g. a Virtuals curve in VIRTUAL):
   * native → asset first, then — once it has landed, so the exact amount is known — the
   * asset's approval if needed and the curve buy itself. Each is its own transaction.
   */
  private async fundedBuy(
    st: TicketState,
    i: number,
    p: BuyParams,
    funding: Funding,
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const { chain, cs, gs, ctx, wallet, amount, route } = p;
    const fail = (error: string) => {
      leg.status = 'failed';
      leg.error = error;
      this.core.update(st);
    };
    const legVenue = this.d.routing.venue(funding.leg.venueId);
    if (!legVenue) return fail(`No route to ${funding.symbol}`);
    const preset = effectivePreset(cs);
    const deadline = () => BigInt(Math.floor(this.d.now() / 1000) + DEADLINE_S);

    // 1) native → asset, as a step of its own.
    st.ticket.legs.push({
      walletId: wallet.id,
      walletName: wallet.name,
      kind: 'step',
      note: `${chain.nativeCurrency.symbol} → ${funding.symbol}`,
      status: 'queued',
    });
    const stepIdx = st.ticket.legs.length - 1;
    const [assetOut] = await legVenue.quote(ctx, funding.leg, 'buy', [amount]);
    if (!assetOut) return fail(`No ${funding.symbol} quote`);
    const assetBps =
      (await this.assetTax(ctx, legVenue, funding, amount, assetOut))?.transfer.buyBps ?? 0;
    const gate = this.balanceGate(chain, ctx, preset, wallet, amount);
    const assetMin = minOutAfter(assetOut, assetBps, FUNDING_SLIPPAGE_BPS);
    const legDeadline = deadline();
    const funded = await this.core.execute(st, stepIdx, {
      chain,
      cs,
      gs,
      wallet,
      tx: legVenue.buildBuy(ctx, funding.leg, {
        wallet: wallet.address,
        amountIn: amount,
        minOut: assetMin,
        deadline: legDeadline,
      }),
      vctx: this.core.validationCtx(
        chain,
        wallet.address,
        p.own,
        { token: funding.asset, maxValue: p.maxValue },
        { ctx, venueId: legVenue.id, pool: funding.leg },
      ),
      kind: 'swap',
      simulate: gs.simulateBeforeSign,
      gate,
      purpose: {
        kind: 'swap',
        ref: { ...refOf(route), leg: true },
        side: 'buy',
        amountIn: amount,
        minOut: assetMin,
        deadline: legDeadline,
      },
    });
    const step = st.ticket.legs[stepIdx] as TicketLeg;
    if (!funded || !step.hash) return fail(`Could not get ${funding.symbol}`);
    const receipt = await ctx.client
      .waitForTransactionReceipt({ hash: step.hash, pollingInterval: 500, timeout: 90_000 })
      .catch(() => null);
    if (!receipt || receipt.status !== 'success')
      return fail(`${funding.symbol} swap did not confirm`);
    const got = tokenReceived(receipt, funding.asset, wallet.address);
    if (got <= 0n) return fail(`No ${funding.symbol} received`);

    // 2) The asset's approval for the curve, if it does not cover this buy.
    const { spender } = route.venue.sellApproval(ctx, route.pool);
    const allowance = await ctx.client.readContract({
      address: funding.asset,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.address, spender],
    });
    let pendingApproval = false;
    if (allowance < got) {
      const target = approvalTarget(gs, got);
      st.ticket.legs.push({
        walletId: wallet.id,
        walletName: wallet.name,
        kind: 'approve',
        note: `Approve ${funding.symbol}`,
        status: 'queued',
      });
      const ok = await this.core.execute(st, st.ticket.legs.length - 1, {
        chain,
        cs,
        gs,
        wallet,
        tx: {
          to: funding.asset,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, target],
          }),
          value: 0n,
        },
        vctx: this.core.validationCtx(
          chain,
          wallet.address,
          p.own,
          { token: funding.asset, maxApproval: target, maxValue: 0n },
          { ctx, venueId: route.venue.id, pool: route.pool },
        ),
        kind: 'approve',
        simulate: gs.simulateBeforeSign,
        purpose: {
          kind: 'approve',
          ref: refOf(route),
          asset: funding.asset,
          spender,
          amount: target,
        },
      });
      if (!ok) return fail(`${funding.symbol} approval failed`);
      pendingApproval = true;
    }

    // 3) The curve buy with exactly what arrived.
    const [out] = await funding.quoteAsset(ctx, 'buy', [got]);
    if (!out) return fail('No quote');
    const taxBps = this.d.tax.peek(ctx, route)?.transfer.buyBps ?? 0;
    const minOut = minOutAfter(out, taxBps, preset.slippageBps);
    const curveDeadline = deadline();
    const ok = await this.core.execute(st, i, {
      chain,
      cs,
      gs,
      wallet,
      tx: route.venue.buildBuy(ctx, route.pool, {
        wallet: wallet.address,
        amountIn: got,
        minOut,
        deadline: curveDeadline,
      }),
      vctx: this.core.validationCtx(
        chain,
        wallet.address,
        p.own,
        { token: route.pool.token, maxValue: 0n },
        { ctx, venueId: route.venue.id, pool: route.pool },
      ),
      kind: 'swap',
      simulate: gs.simulateBeforeSign && !pendingApproval,
      purpose: {
        kind: 'swap',
        ref: refOf(route),
        side: 'buy',
        amountIn: got,
        minOut,
        deadline: curveDeadline,
      },
    });
    if (ok)
      await this.ensureSellApproval(st, {
        chain,
        cs,
        gs,
        ctx,
        wallet,
        pool: route.pool,
        venueId: route.venue.id,
        extra: out,
        own: p.own,
      });
  }

  /**
   * Approval right after a buy so later sells are one click. Unlimited (the default) is
   * sent once per token and spender; bounded covers the current holdings plus what was
   * just bought, plus the configured buffer, and is topped up after each buy.
   */
  private async ensureSellApproval(
    st: TicketState,
    p: {
      chain: ChainConfig;
      cs: ChainSettings;
      gs: GlobalSettings;
      ctx: VenueCtx;
      wallet: EvmAccount;
      pool: PoolRef;
      venueId: string;
      extra: bigint;
      own: Address[];
      /** Instead of the venue's own spender (Permit2 for sells through the Nesty Router). */
      spender?: Address;
    },
  ): Promise<void> {
    const venue = this.d.routing.venue(p.venueId);
    // Exact-approval venues (aggregators) approve each sell itself, never ahead.
    if (!venue || venue.exactApproval) return;
    const spender = p.spender ?? venue.sellApproval(p.ctx, p.pool).spender;
    const token = p.pool.token;
    const [allowance, balance] = await Promise.all([
      p.ctx.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [p.wallet.address, spender],
      }),
      p.ctx.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [p.wallet.address],
      }),
    ]);
    const needed = balance + p.extra;
    if (allowance >= needed) return;
    const target = approvalTarget(p.gs, needed);
    const tx: TxDraft = {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, target] }),
      value: 0n,
    };
    st.ticket.legs.push({
      walletId: p.wallet.id,
      walletName: p.wallet.name,
      kind: 'approve',
      status: 'queued',
    });
    const idx = st.ticket.legs.length - 1;
    const vctx = this.core.validationCtx(
      p.chain,
      p.wallet.address,
      p.own,
      { token, maxApproval: target, maxValue: 0n },
      { ctx: p.ctx, venueId: p.venueId, pool: p.pool },
    );
    // The buy is not mined yet, so estimateGas would see the old balance; approve does not depend on it.
    await this.core.execute(st, idx, {
      ...p,
      tx,
      vctx,
      kind: 'approve',
      simulate: false,
      purpose: {
        kind: 'approve',
        ref: { token, venueId: p.venueId, poolId: p.pool.id },
        asset: token,
        spender,
        amount: target,
      },
    });
  }

  // ── sell ──────────────────────────────────────────────────────────────────

  async sell(
    req: {
      chainId: number;
      token: Address;
      bps: number;
      walletIds: string[];
      confirmed: boolean;
      clickedAt?: number | undefined;
      /** A website trade's own settings, in place of the stored ones. */
      prefs?: TradePrefs | undefined;
    },
    tabId?: number,
  ): Promise<TradeTicket> {
    const startedAt = this.core.clickTime(req.clickedAt);
    const { chain, cs, gs, ctx } = await this.core.context(req.chainId, req.prefs);
    const wallets = await this.core.wallets(req.walletIds);
    const balances = await Promise.all(
      wallets.map((w) =>
        ctx.client.readContract({
          address: req.token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [w.address],
        }),
      ),
    );
    const amounts = balances.map((b) => (b * BigInt(req.bps)) / 10_000n);
    const totalIn = amounts.reduce((a, b) => a + b, 0n);
    if (totalIn === 0n) throw new TradeError('insufficient_funds', 'No tokens to sell.');

    const route =
      this.d.routing.cached(ctx, req.token, 'sell', totalIn, gs.maxQuoteAgeMs) ??
      (await this.d.routing.best(ctx, req.token, 'sell', [totalIn]))[0];
    if (!route) throw new TradeError('no_route');
    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    const outUsd = nativeUsd !== null ? Number(formatEther(route.out)) * nativeUsd : null;
    // Sells return funds to the user, so only the confirmation threshold applies.
    if (outUsd !== null && outUsd > gs.confirmAboveUsd && !req.confirmed) {
      throw new TradeError('needs_confirmation', `$${outUsd.toFixed(2)}`);
    }

    const symbol = this.core.symbolNow(ctx, req.token);
    const legs: TicketLeg[] = wallets.map((w, i) => ({
      walletId: w.id,
      walletName: w.name,
      kind: 'swap',
      status: amounts[i] === 0n ? 'skipped' : 'queued',
      amountIn: (amounts[i] ?? 0n).toString(),
      ...(amounts[i] === 0n ? { error: 'No balance' } : {}),
    }));
    const st = this.core.newTicket('sell', chain, legs, tabId, req.token, symbol);
    st.startedAt = startedAt;
    this.core.describe(st, ctx, cs, route, nativeUsd);
    if (!symbol) this.core.fillSymbol(st, ctx, req.token);
    const own = (await this.d.vault.listAccounts()).filter(hasEvm).map((a) => a.address);

    void (async () => {
      for (let i = 0; i < wallets.length; i++) {
        const amount = amounts[i] ?? 0n;
        if (amount === 0n) continue;
        if (i > 0 && gs.jitterMaxMs > 0) await sleep(Math.floor(Math.random() * gs.jitterMaxMs));
        void this.sellOne(st, i, {
          chain,
          cs,
          gs,
          ctx,
          wallet: wallets[i] as EvmAccount,
          amount,
          balance: balances[i] ?? 0n,
          route,
          quotedIn: totalIn,
          own,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  private async sellOne(st: TicketState, i: number, p: SellParams): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const { chain, cs, gs, ctx, wallet, amount, route } = p;
    const token = route.pool.token;
    const ref = p.ref ?? refOf(route);
    try {
      const preset = effectivePreset(cs);
      const funding = route.venue.funding?.(ctx, route.pool);
      const via = funding ? this.viaRouter(chain, ctx, funding) : null;
      // Through the Nesty Router, the tokens go to it in a one-time Permit2 transfer.
      const approval = via
        ? { spender: PERMIT2, viaPermit2: false, router: via.router }
        : route.venue.sellApproval(ctx, route.pool);
      const [out, allowance] = await Promise.all([
        // A single-wallet sell has exactly the amount that was just quoted.
        amount === p.quotedIn
          ? Promise.resolve(route.out)
          : this.d.routing.requote(ctx, route.pool, 'sell', amount),
        ctx.client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [wallet.address, approval.spender],
        }),
      ]);
      if (!out) {
        leg.status = 'failed';
        leg.error = 'No quote';
        this.core.update(st);
        return;
      }

      // 1) ERC-20 approval if the allowance does not cover this sell.
      let pendingApproval = false;
      if (allowance < amount) {
        const target = route.venue.exactApproval ? amount : approvalTarget(gs, p.balance);
        const tx: TxDraft = {
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [approval.spender, target],
          }),
          value: 0n,
        };
        st.ticket.legs.push({
          walletId: wallet.id,
          walletName: wallet.name,
          kind: 'approve',
          status: 'queued',
        });
        const idx = st.ticket.legs.length - 1;
        const vctx = this.core.validationCtx(
          chain,
          wallet.address,
          p.own,
          { token, maxApproval: target, maxValue: 0n },
          { ctx, venueId: route.venue.id, pool: route.pool },
        );
        if (
          !(await this.core.execute(st, idx, {
            chain,
            cs,
            gs,
            wallet,
            tx,
            vctx,
            kind: 'approve',
            simulate: gs.simulateBeforeSign,
            purpose: {
              kind: 'approve',
              ref,
              asset: token,
              spender: approval.spender,
              amount: target,
            },
          }))
        ) {
          leg.status = 'failed';
          leg.error = 'Approval failed';
          this.core.update(st);
          return;
        }
        pendingApproval = true;
      }
      if (funding && via) {
        await this.routerSell(st, i, p, funding, via, { out, pendingApproval });
        return;
      }

      const nowS = Math.floor(this.d.now() / 1000);
      const vctx = this.core.validationCtx(
        chain,
        wallet.address,
        p.own,
        { token, maxPermit: amount, maxValue: 0n },
        { ctx, venueId: route.venue.id, pool: route.pool },
      );

      // 2) Permit2 signature for exactly this amount, when the router's Permit2 allowance is short.
      let permit: { signature: Hex; permit: ReturnType<typeof buildPermit> } | undefined;
      if (approval.viaPermit2) {
        const p2 = await readPermit2Allowance(ctx.client, wallet.address, token, approval.router);
        if (p2.amount < amount || p2.expiration <= nowS + 60) {
          const permitMsg = buildPermit(token, approval.router, amount, p2.nonce, nowS);
          const check = validatePermit(permitMsg, vctx);
          if (!check.ok) {
            leg.status = 'blocked';
            st.ticket.blocked = check.actions;
            this.core.update(st);
            return;
          }
          const signature = await this.core.signer.permit(wallet, chain.id, {
            kind: 'permit',
            ref,
            permit: permitMsg,
          });
          permit = { signature, permit: permitMsg };
        }
      }

      // 3) The swap itself. The sell's transfer tax is not in the quote either.
      const taxBps = this.d.tax.peek(ctx, route)?.transfer.sellBps ?? 0;
      // A funded pool pays out the asset (e.g. VIRTUAL): its minimum is in that asset.
      const assetOut = funding ? (await funding.quoteAsset(ctx, 'sell', [amount]))[0] : out;
      if (!assetOut) {
        leg.status = 'failed';
        leg.error = 'No quote';
        this.core.update(st);
        return;
      }
      const minOut = minOutAfter(assetOut, taxBps, preset.slippageBps);
      const deadline = BigInt(nowS + DEADLINE_S);
      const tx = await buildTx(route.venue, ctx, route.pool, 'sell', {
        wallet: wallet.address,
        amountIn: amount,
        minOut,
        deadline,
        permit,
      });
      const sold = await this.core.execute(st, i, {
        chain,
        cs,
        gs,
        wallet,
        tx,
        vctx,
        kind: 'swap',
        // With an approval still pending, simulation would fail for the wrong reason.
        simulate: gs.simulateBeforeSign && !pendingApproval,
        purpose: { kind: 'swap', ref, side: 'sell', amountIn: amount, minOut, deadline, permit },
      });
      if (sold && funding) await this.unfund(st, i, p, funding);
    } catch (e) {
      leg.status = 'failed';
      leg.error = shortErr(e);
      markRefused(st.ticket, leg, e);
      this.core.update(st);
    }
  }

  /**
   * Sell on a funded pool in ONE transaction through the Nesty Router: a one-time Permit2
   * transfer of exactly `amount` to the router, the curve sell, then asset → native to the
   * wallet. The token's Permit2 approval was handled by sellOne.
   */
  private async routerSell(
    st: TicketState,
    i: number,
    p: SellParams,
    funding: Funding,
    via: { router: Address; legVenue: Venue },
    q: { out: bigint; pendingApproval: boolean },
  ): Promise<void> {
    const leg = st.ticket.legs[i] as TicketLeg;
    const { chain, cs, gs, ctx, wallet, amount, route } = p;
    const token = route.pool.token;
    const preset = effectivePreset(cs);
    const fail = (error: string) => {
      leg.status = 'failed';
      leg.error = error;
      this.core.update(st);
    };
    const [assetOut] = await funding.quoteAsset(ctx, 'sell', [amount]);
    if (!assetOut) return fail('No quote');
    const vctx = this.core.validationCtx(
      chain,
      wallet.address,
      p.own,
      { token, fundingAsset: funding.asset, maxPermit: amount, maxValue: 0n },
      { ctx, venueId: route.venue.id, pool: route.pool },
    );
    const permit = buildTransferPermit(token, amount, Math.floor(this.d.now() / 1000));
    const check = checkTransferPermit(permit, via.router, vctx);
    if (!check.ok) {
      leg.status = 'blocked';
      st.ticket.blocked = [check];
      this.core.update(st);
      return;
    }
    const signature = await this.core.signer.permit(wallet, chain.id, {
      kind: 'transfer',
      ref: refOf(route),
      permit,
      spender: via.router,
    });

    const taxBps = this.d.tax.peek(ctx, route)?.transfer.sellBps ?? 0;
    // Selling the asset back to native pays its own tax too (cached from the buy, as a rule).
    const assetBps =
      (await this.assetTax(ctx, via.legVenue, funding, q.out, assetOut))?.transfer.sellBps ?? 0;
    const minOut = minOutAfter(q.out, taxBps + assetBps, preset.slippageBps);
    const r = this.fundedRoute(ctx, wallet.address, route, funding, via);
    const assetMin = minOutAfter(assetOut, taxBps, preset.slippageBps);
    const calls = routerSellCalls({ ...r, assetMin, minOut });
    if (!calls) return fail(`No way back from ${funding.symbol}`);
    const tx: TxDraft = {
      to: via.router,
      data: encodeRouterExecute({
        calls,
        permit: { permit, signature },
        tokenOut: ROUTER_NATIVE,
        minOut,
        sweep: [token, funding.asset, chain.wrappedNative],
        deadline: r.deadline,
      }),
      value: 0n,
    };
    await this.core.execute(st, i, {
      chain,
      cs,
      gs,
      wallet,
      tx,
      vctx,
      kind: 'routed',
      // With the Permit2 approval still pending, simulation would fail for the wrong reason:
      // then the router's static limit applies. Otherwise always measured, as for the buy.
      simulate: !q.pendingApproval,
      purpose: {
        kind: 'router',
        ref: refOf(route),
        side: 'sell',
        amountIn: amount,
        assetMin,
        minOut,
        deadline: r.deadline,
        permit: { permit, signature },
      },
    });
  }

  /**
   * After a sell on a funded pool: wait for it, then sell exactly the asset it paid out
   * back to native, as a step of the same ticket (approval and permit handled as usual).
   */
  private async unfund(st: TicketState, i: number, p: SellParams, funding: Funding): Promise<void> {
    const { chain, ctx, wallet } = p;
    const leg = st.ticket.legs[i] as TicketLeg;
    const legVenue = this.d.routing.venue(funding.leg.venueId);
    if (!legVenue || !leg.hash) return;
    const receipt = await ctx.client
      .waitForTransactionReceipt({ hash: leg.hash, pollingInterval: 500, timeout: 90_000 })
      .catch(() => null);
    if (!receipt || receipt.status !== 'success') return;
    const got = tokenReceived(receipt, funding.asset, wallet.address);
    if (got <= 0n) return;
    st.ticket.legs.push({
      walletId: wallet.id,
      walletName: wallet.name,
      kind: 'step',
      note: `${funding.symbol} → ${chain.nativeCurrency.symbol}`,
      status: 'queued',
    });
    await this.sellOne(st, st.ticket.legs.length - 1, {
      ...p,
      amount: got,
      balance: got,
      route: { venue: legVenue, pool: funding.leg, out: 0n },
      // Never equal to `got`, so the step is quoted fresh.
      quotedIn: -1n,
      ref: { ...refOf(p.route), leg: true },
    });
  }
}
