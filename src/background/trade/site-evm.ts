import {
  encodeFunctionData,
  formatEther,
  isAddressEqual,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { LAUNCHPADS, createSpecProblem } from '../../shared/create';
import { formatToken } from '../../shared/format';
import { sanitizeLabel } from '../../shared/sanitize';
import type { GlobalSettings } from '../../shared/settings/defaults';
import type { WireCreateSpec } from '../../shared/site-bridge';
import type { BlockedAction } from '../../shared/panel';
import type { EvmAccount } from '../../shared/wallet';
import { erc20Abi } from '../chain/abis';
import {
  PONS_LAUNCH_FACTORY,
  buildCreateTx,
  createValue,
  flapSaltOk,
  ponsLaunchAbi,
} from '../create/evm';
import { act } from './actions';
import {
  ROUTER_NATIVE,
  checkTransferPermit,
  encodeRouterExecute,
  legSupported,
  routerBuyCalls,
  routerSellCalls,
  type FundedRoute,
} from './nesty-router';
import {
  chainContext,
  expectedFeeWei,
  gasFeeRefusal,
  validationContext,
  type EngineDeps,
} from './engine/core';
import { approvalTarget } from './engine/trading';
import type { GasKind } from './fees';
import type { EvmTx, PermitPurpose, TradeRef, TxPurpose } from './signer';
import type { Funding, PoolRef, TxDraft, Venue, VenueCtx } from './types';
import { PERMIT2 } from './uniswap/addresses';
import {
  validatePermit,
  validateTx,
  type ExtraContractRule,
  type ValidationContext,
} from './validator';

/**
 * The extension's check of an EVM transaction the Nesty website asks it to sign. The site
 * runs the trade engine itself and sends, with each transaction, how it built it (its
 * purpose). Here the pool is found again from the chain, the transaction is built again
 * with the venue's own builder from that purpose, and only an exact match goes on: then
 * the validator with the user's limits, a minimum received of at least half what the
 * pool pays now (the site's slippage may be the user's; no site may set none), and the
 * gas fee against the user's gas limit. Aggregator routes are never signed for the site:
 * their calldata comes from an outside API and cannot be built again. A new coin is
 * built again from its spec (create/evm.ts) the same way.
 */

export type SiteEvmDeps = Pick<
  EngineDeps,
  'settings' | 'client' | 'fetchJson' | 'routing' | 'prices' | 'fees' | 'extraContracts' | 'now'
>;

export type SiteEvmCheck =
  | {
      ok: true;
      /** For the confirmation window, when a buy needs the user. */
      summary: string;
      /** A buy's spend in USD (held to the minute's budget); null for anything else. */
      usd: number | null;
      /** What a buy should bring, for bounded approvals that follow it. */
      bought?: { token: Address; out: bigint };
    }
  | { ok: false; reason: string; actions?: BlockedAction[] };

/** Signed transactions are remembered this long, for a speed-up of one of them. */
const SIGNED_TTL_MS = 60 * 60_000;
const MAX_SIGNED = 256;
/** Buys a bounded approval right after them must cover. */
const BOUGHT_TTL_MS = 5 * 60_000;

const refuse = (reason: string): SiteEvmCheck => ({ ok: false, reason });

/** A refusal that names the decoded action, for the website to list. */
const refuseActions = (actions: BlockedAction[]): SiteEvmCheck => ({
  ok: false,
  reason: actions.find((a) => !a.ok)?.reason ?? 'Blocked.',
  actions,
});

const sameTx = (a: TxDraft, b: TxDraft) =>
  isAddressEqual(a.to, b.to) &&
  a.data.toLowerCase() === b.data.toLowerCase() &&
  a.value === b.value;

/** Where a purpose trades: the pool itself, or its funding leg. */
interface Target {
  venue: Venue;
  pool: PoolRef;
  /** The token moving on that pool besides native: the pool's token, or the asset. */
  token: Address;
}

interface Found {
  ctx: VenueCtx;
  venue: Venue;
  pool: PoolRef;
  funding: Funding | undefined;
  legVenue: Venue | undefined;
  target: Target;
}

export class SiteEvmChecker {
  /** Transactions signed for the site, by chain, sender and nonce. */
  private readonly signed = new Map<string, { tx: TxDraft; kind: GasKind; at: number }>();
  /** Buys signed lately, by chain, wallet and token. */
  private readonly bought = new Map<string, { out: bigint; at: number }[]>();
  private readonly symbols = new Map<string, string>();

  constructor(private readonly d: SiteEvmDeps) {}

  async checkTx(
    wallet: EvmAccount,
    own: readonly Address[],
    tx: EvmTx,
    purpose: TxPurpose,
  ): Promise<SiteEvmCheck> {
    const { chain, gs, ctx } = await chainContext(this.d, tx.chainId);
    const replaced =
      purpose.kind === 'replace' ? this.signed.get(signedKey(tx, wallet.address)) : undefined;
    const kind: GasKind =
      purpose.kind === 'replace'
        ? (replaced?.kind ?? 'swap')
        : purpose.kind === 'approve'
          ? 'approve'
          : purpose.kind === 'router'
            ? 'routed'
            : purpose.kind === 'empty'
              ? 'transfer'
              : 'swap';
    const [nativeUsd, baseFee] = await Promise.all([
      this.d.prices.nativeUsd(ctx).catch(() => null),
      this.d.fees.baseFee(chain, ctx.client, this.d.now()).catch(() => null),
    ]);
    const symbol = chain.nativeCurrency.symbol;
    // Without a price neither the trade nor its gas can be held to the user's limits.
    if (nativeUsd === null) return refuse(`Nesty could not price ${symbol} to check this.`);
    const feeRefusal = gasFeeRefusal(
      // A new coin's gas is the site's estimate with its margin, far above any trade's.
      expectedFeeWei(chain, tx, baseFee, tx.gas, purpose.kind === 'create', kind),
      nativeUsd,
      gs.maxGasUsd,
      symbol,
    );
    if (feeRefusal) return refuse(feeRefusal);

    if (purpose.kind === 'empty') {
      return isAddressEqual(tx.to, wallet.address) && tx.data === '0x' && tx.value === 0n
        ? { ok: true, summary: 'Cancel a pending transaction', usd: null }
        : refuse('Only an empty transfer to the wallet itself cancels a transaction.');
    }
    if (purpose.kind === 'replace') {
      if (!replaced)
        return refuse('Nesty no longer has this transaction to speed up. Cancel it instead.');
      return sameTx(replaced.tx, tx)
        ? { ok: true, summary: 'Speed up a pending transaction', usd: null }
        : refuse('A speed-up must send the same transaction again.');
    }

    const b: Base = {
      chain,
      own,
      wallet,
      tx,
      nativeUsd,
      maxValue: parseEther((gs.maxUsdPerTx / nativeUsd).toFixed(18)),
    };
    if (purpose.kind === 'create') return this.create(ctx, b, purpose.spec);
    const found = await this.find(ctx, purpose.ref);
    if (typeof found === 'string') return refuse(found);
    if (purpose.kind === 'approve') return this.approve(found, b, purpose, gs);
    if (purpose.kind === 'router') return this.router(found, b, purpose);
    return this.swap(found, b, purpose);
  }

  async checkPermit(
    wallet: EvmAccount,
    own: readonly Address[],
    chainId: number,
    purpose: PermitPurpose,
  ): Promise<SiteEvmCheck> {
    const { chain, ctx } = await chainContext(this.d, chainId);
    const found = await this.find(ctx, purpose.ref);
    if (typeof found === 'string') return refuse(found);
    const { target, pool, funding } = found;
    const balance = await this.balance(ctx.client, target.token, wallet.address);
    const route = { ctx, venueId: target.venue.id, pool: target.pool };
    if (purpose.kind === 'permit') {
      const approval = target.venue.sellApproval(ctx, target.pool);
      if (!approval.viaPermit2) return refuse('This pool does not sell through Permit2.');
      if (!isAddressEqual(purpose.permit.details.token, target.token))
        return refuse('This permit is for another token.');
      const vctx = validationContext(
        this.d,
        chain,
        wallet.address,
        own,
        { token: target.token, maxPermit: balance, maxValue: 0n },
        route,
      );
      const verdict = validatePermit(purpose.permit, vctx);
      if (!verdict.ok) return refuseActions(verdict.actions);
      return { ok: true, summary: `Let ${target.pool.label} sell your tokens once`, usd: null };
    }
    if (purpose.ref.leg || !funding || !found.legVenue)
      return refuse('Only a funded pool sells through the Nesty Router.');
    const vctx = validationContext(
      this.d,
      chain,
      wallet.address,
      own,
      { token: pool.token, fundingAsset: funding.asset, maxPermit: balance, maxValue: 0n },
      route,
    );
    const check = checkTransferPermit(purpose.permit, purpose.spender, vctx);
    if (!check.ok) return refuse(check.reason ?? 'Blocked.');
    return { ok: true, summary: `Let the Nesty Router sell on ${pool.label} once`, usd: null };
  }

  /** After a signature: remembered for a speed-up, and a buy for the approval after it. */
  noteSigned(wallet: EvmAccount, tx: EvmTx, purpose: TxPurpose, check: SiteEvmCheck): void {
    const now = this.d.now();
    for (const [k, v] of this.signed) if (now - v.at > SIGNED_TTL_MS) this.signed.delete(k);
    if (this.signed.size >= MAX_SIGNED) this.signed.clear();
    const kind: GasKind =
      purpose.kind === 'approve' ? 'approve' : purpose.kind === 'router' ? 'routed' : 'swap';
    const key = signedKey(tx, wallet.address);
    if (purpose.kind !== 'replace' && purpose.kind !== 'empty')
      this.signed.set(key, { tx: { to: tx.to, data: tx.data, value: tx.value }, kind, at: now });
    if (check.ok && check.bought) {
      const k = boughtKey(tx.chainId, wallet.address, check.bought.token);
      this.bought.set(k, [...this.recentBuys(k), { out: check.bought.out, at: now }]);
    }
  }

  // ── per purpose ───────────────────────────────────────────────────────────

  private async swap(
    f: Found,
    b: Base,
    p: Extract<TxPurpose, { kind: 'swap' }>,
  ): Promise<SiteEvmCheck> {
    const { ctx, target, funding, legVenue } = f;
    const params = {
      wallet: b.wallet.address,
      amountIn: p.amountIn,
      minOut: p.minOut,
      deadline: p.deadline,
      permit: p.permit,
    };
    const expected =
      p.side === 'buy'
        ? target.venue.buildBuy(ctx, target.pool, params)
        : target.venue.buildSell(ctx, target.pool, params);
    if (!sameTx(expected, b.tx)) return refuse('This transaction is not the trade it says it is.');
    // A funded pool's own swap trades its asset, not native.
    const inAsset = !p.ref.leg && !!funding;
    const [quoted, worth, sym] = await Promise.all([
      (inAsset && funding
        ? funding.quoteAsset(ctx, p.side, [p.amountIn])
        : target.venue.quote(ctx, target.pool, p.side, [p.amountIn])
      ).then(
        ([q]) => q ?? null,
        () => null,
      ),
      // What the asset spent on such a buy is worth in native, for the user's limits.
      inAsset && p.side === 'buy' && funding && legVenue
        ? legVenue.quote(ctx, funding.leg, 'sell', [p.amountIn]).then(
            ([q]) => q ?? null,
            () => null,
          )
        : Promise.resolve(null),
      p.side === 'buy' ? this.symbolOf(ctx, target.token) : Promise.resolve(''),
    ]);
    const fill = minOutRefusal(p.minOut, quoted);
    if (fill) return refuse(fill);
    let spent = b.tx.value;
    if (inAsset && p.side === 'buy') {
      if (worth === null) return refuse('Nesty could not price what this buy spends.');
      if (worth > b.maxValue) return refuse('This buy is above your per-transaction limit.');
      spent = worth;
    }
    const vctx = this.vctx(f, b, {
      token: target.token,
      maxValue: p.side === 'buy' && !inAsset ? b.maxValue : 0n,
      ...(p.side === 'sell' ? { maxPermit: p.amountIn } : {}),
    });
    const verdict = validateTx(b.tx, vctx);
    if (!verdict.ok) return refuseActions(verdict.actions);
    if (p.side === 'sell') return { ok: true, summary: `Sell on ${target.pool.label}`, usd: null };
    return {
      ok: true,
      summary: `Buy ${sym} for about ${formatToken(spent, 18)} ${b.chain.nativeCurrency.symbol} on ${target.pool.label}`,
      usd: Number(formatEther(spent)) * b.nativeUsd,
      bought: { token: target.token, out: quoted ?? 0n },
    };
  }

  private async router(
    f: Found,
    b: Base,
    p: Extract<TxPurpose, { kind: 'router' }>,
  ): Promise<SiteEvmCheck> {
    const { ctx, venue, pool, funding, legVenue } = f;
    const router = b.chain.nestyRouter;
    if (p.ref.leg || !funding || !legVenue || !router || !legSupported(ctx, legVenue, funding.leg))
      return refuse('This pool does not trade through the Nesty Router.');
    const r: FundedRoute = {
      ctx,
      router,
      wallet: b.wallet.address,
      venue,
      pool,
      legVenue,
      leg: funding.leg,
      asset: funding.asset,
      deadline: p.deadline,
    };
    let expected: TxDraft;
    if (p.side === 'buy') {
      const calls = routerBuyCalls({
        ...r,
        amountIn: p.amountIn,
        assetMin: p.assetMin,
        minOut: p.minOut,
      });
      expected = {
        to: router,
        data: encodeRouterExecute({
          calls,
          tokenOut: pool.token,
          minOut: p.minOut,
          sweep: [funding.asset, b.chain.wrappedNative],
          deadline: p.deadline,
        }),
        value: p.amountIn,
      };
    } else {
      const calls = routerSellCalls({ ...r, assetMin: p.assetMin, minOut: p.minOut });
      if (!calls || !p.permit) return refuse('This sell cannot go through the Nesty Router.');
      expected = {
        to: router,
        data: encodeRouterExecute({
          calls,
          permit: p.permit,
          tokenOut: ROUTER_NATIVE,
          minOut: p.minOut,
          sweep: [pool.token, funding.asset, b.chain.wrappedNative],
          deadline: p.deadline,
        }),
        value: 0n,
      };
    }
    if (!sameTx(expected, b.tx)) return refuse('This transaction is not the trade it says it is.');
    const first = (q: Promise<(bigint | null)[]>) =>
      q.then(
        ([v]) => v ?? null,
        () => null,
      );
    const [assetQuoted, quoted, sym] = await Promise.all([
      first(
        p.side === 'buy'
          ? legVenue.quote(ctx, funding.leg, 'buy', [p.amountIn])
          : funding.quoteAsset(ctx, 'sell', [p.amountIn]),
      ),
      first(venue.quote(ctx, pool, p.side, [p.amountIn])),
      p.side === 'buy' ? this.symbolOf(ctx, pool.token) : Promise.resolve(''),
    ]);
    const fill = minOutRefusal(p.assetMin, assetQuoted) ?? minOutRefusal(p.minOut, quoted);
    if (fill) return refuse(fill);
    const vctx = this.vctx(f, b, {
      token: pool.token,
      fundingAsset: funding.asset,
      maxValue: p.side === 'buy' ? b.maxValue : 0n,
      ...(p.side === 'sell' ? { maxPermit: p.amountIn } : {}),
    });
    if (p.permit) {
      const check = checkTransferPermit(p.permit.permit, router, vctx);
      if (!check.ok) return refuse(check.reason ?? 'Blocked.');
    }
    const verdict = validateTx(b.tx, vctx);
    if (!verdict.ok) return refuseActions(verdict.actions);
    if (p.side === 'sell') return { ok: true, summary: `Sell on ${pool.label}`, usd: null };
    return {
      ok: true,
      summary: `Buy ${sym} for ${formatToken(p.amountIn, 18)} ${b.chain.nativeCurrency.symbol} on ${pool.label}`,
      usd: Number(formatEther(p.amountIn)) * b.nativeUsd,
      bought: { token: pool.token, out: quoted ?? 0n },
    };
  }

  private async approve(
    f: Found,
    b: Base,
    p: Extract<TxPurpose, { kind: 'approve' }>,
    gs: GlobalSettings,
  ): Promise<SiteEvmCheck> {
    const { ctx, venue, pool, funding, legVenue, target } = f;
    // The approvals Nesty's own flows send for this pool, and no others.
    const allowed: [Address, Address][] = p.ref.leg
      ? funding && legVenue
        ? [[funding.asset, legVenue.sellApproval(ctx, funding.leg).spender]]
        : []
      : [
          [pool.token, venue.sellApproval(ctx, pool).spender],
          // Sells through the Nesty Router take the tokens with a Permit2 transfer.
          ...(funding ? ([[pool.token, PERMIT2]] as [Address, Address][]) : []),
          // A funded buy without the router spends the asset on the curve.
          ...(funding
            ? ([[funding.asset, venue.sellApproval(ctx, pool).spender]] as [Address, Address][])
            : []),
        ];
    if (!allowed.some(([a, s]) => isAddressEqual(a, p.asset) && isAddressEqual(s, p.spender)))
      return refuse('Nesty does not approve this spender for this pool.');
    const expected: TxDraft = {
      to: p.asset,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [p.spender, p.amount],
      }),
      value: 0n,
    };
    if (!sameTx(expected, b.tx))
      return refuse('This transaction is not the approval it says it is.');
    let maxApproval = maxUint256;
    if (!gs.unlimitedApprovals) {
      // Holdings and the buys just signed, with room for quotes that moved in between.
      const held = await this.balance(ctx.client, p.asset, b.wallet.address);
      const coming = this.recentBuys(boughtKey(b.chain.id, b.wallet.address, p.asset)).reduce(
        (sum, x) => sum + x.out,
        0n,
      );
      maxApproval = approvalTarget(gs, (held + coming) * 2n);
    }
    // The validator's token is the one approved: the pool's, or its asset.
    const vctx = this.vctx(f, b, { token: p.asset, maxApproval, maxValue: 0n });
    const verdict = validateTx(b.tx, vctx);
    if (!verdict.ok) return refuseActions(verdict.actions);
    return { ok: true, summary: `Approve a token for ${target.pool.label}`, usd: null };
  }

  /** A coin from the site's create form: exactly the factory call Nesty builds for it. */
  private async create(ctx: VenueCtx, b: Base, spec: WireCreateSpec): Promise<SiteEvmCheck> {
    const problem = createSpecProblem(b.chain.id, spec);
    if (problem) return refuse(problem);
    let expected: TxDraft;
    try {
      expected = buildCreateTx(b.chain.id, b.wallet.address, spec);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : 'Nesty does not create this coin here.');
    }
    if (!sameTx(expected, b.tx)) return refuse('This transaction is not the coin it says it is.');
    // Flap reverts on any other address; Pons takes its fee and nothing else.
    if (spec.launchpad === 'flap' && !flapSaltOk(b.chain.id, spec.taxBps, spec.salt as Hex))
      return refuse('Its salt does not give the address Flap requires.');
    if (spec.launchpad === 'pons') {
      const fee = await ctx.client
        .readContract({
          address: PONS_LAUNCH_FACTORY,
          abi: ponsLaunchAbi,
          functionName: 'launchFee',
        })
        .catch(() => null);
      if (fee === null) return refuse('Nesty could not read the Pons launch fee.');
      if (BigInt(spec.fee) !== fee) return refuse('This is not the Pons launch fee.');
    }
    const label = LAUNCHPADS[spec.launchpad].label;
    // The validator, with this one factory call as the only contract it lets through.
    const rule: ExtraContractRule = {
      label,
      validate: (tx) => [
        sameTx(expected, tx)
          ? act(`Create ${spec.symbol} on ${label}`)
          : act(`Create on ${label}`, 'Not the coin it says it is'),
      ],
    };
    const verdict = validateTx(b.tx, {
      chain: b.chain,
      from: b.wallet.address,
      ownWallets: b.own,
      extraContracts: new Map([[expected.to.toLowerCase(), rule]]),
      maxValue: b.maxValue,
      nowS: Math.floor(this.d.now() / 1000),
    });
    if (!verdict.ok) return refuseActions(verdict.actions);
    const value = createValue(spec);
    const amount = `${formatToken(value, 18)} ${b.chain.nativeCurrency.symbol}`;
    return {
      ok: true,
      summary:
        spec.launchpad === 'pons'
          ? `Create ${spec.symbol} on ${label} for its ${amount} launch fee`
          : value > 0n
            ? `Create ${spec.symbol} on ${label} and buy it for ${amount}`
            : `Create ${spec.symbol} on ${label}`,
      usd: Number(formatEther(value)) * b.nativeUsd,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The pool from the chain (the venues' own discovery), never from the site. */
  private async find(ctx: VenueCtx, ref: TradeRef): Promise<Found | string> {
    const match = (pools: PoolRef[]) =>
      pools.find((p) => p.venueId === ref.venueId && p.id === ref.poolId);
    const pool =
      match(await this.d.routing.discover(ctx, ref.token)) ??
      // Found by the site but not here yet: a pool made since (a migration).
      match(await this.d.routing.discover(ctx, ref.token, true));
    const venue = pool ? this.d.routing.venue(pool.venueId) : undefined;
    if (!pool || !venue) return 'Nesty could not find this pool on the chain.';
    if (venue.prepare || this.d.routing.isFallback(venue))
      return 'Nesty does not sign aggregator routes for the site.';
    const funding = venue.funding?.(ctx, pool);
    const legVenue = funding ? this.d.routing.venue(funding.leg.venueId) : undefined;
    if (ref.leg) {
      if (!funding || !legVenue) return 'This pool has no funding leg.';
      return {
        ctx,
        venue,
        pool,
        funding,
        legVenue,
        target: { venue: legVenue, pool: funding.leg, token: funding.asset },
      };
    }
    return { ctx, venue, pool, funding, legVenue, target: { venue, pool, token: pool.token } };
  }

  private vctx(
    f: Pick<Found, 'ctx' | 'target'>,
    b: Base,
    extra: Partial<ValidationContext> & { maxValue: bigint },
  ): ValidationContext {
    return validationContext(this.d, b.chain, b.wallet.address, b.own, extra, {
      ctx: f.ctx,
      venueId: f.target.venue.id,
      pool: f.target.pool,
    });
  }

  private recentBuys(key: string) {
    const since = this.d.now() - BOUGHT_TTL_MS;
    const list = (this.bought.get(key) ?? []).filter((x) => x.at > since);
    if (list.length > 0) this.bought.set(key, list);
    else this.bought.delete(key);
    return list;
  }

  private balance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
    return client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });
  }

  private async symbolOf(ctx: VenueCtx, token: Address): Promise<string> {
    const key = `${ctx.chain.id}:${token.toLowerCase()}`;
    const hit = this.symbols.get(key);
    if (hit) return hit;
    const sym =
      sanitizeLabel(
        await ctx.client
          .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
          .catch(() => ''),
        16,
      ) || 'a token';
    if (this.symbols.size > 500) this.symbols.clear();
    this.symbols.set(key, sym);
    return sym;
  }
}

interface Base {
  chain: ValidationContext['chain'];
  own: readonly Address[];
  wallet: EvmAccount;
  tx: EvmTx;
  nativeUsd: number;
  maxValue: bigint;
}

function signedKey(tx: Pick<EvmTx, 'chainId' | 'nonce'>, from: Address): string {
  return `${tx.chainId}:${from.toLowerCase()}:${tx.nonce}`;
}

function boughtKey(chainId: number, wallet: Address, token: Address): string {
  return `${chainId}:${wallet.toLowerCase()}:${token.toLowerCase()}`;
}

/** Why a minimum received is too low against what the pool pays now, or null. */
function minOutRefusal(minOut: bigint, quoted: bigint | null): string | null {
  if (quoted === null || quoted === 0n) return 'This trade cannot fill right now.';
  if (minOut * 2n < quoted)
    return 'Its minimum received is under half of what this trade pays now.';
  return null;
}
