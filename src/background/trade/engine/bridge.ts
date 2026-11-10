import { encodeFunctionData, formatEther, formatUnits, parseEther, type Address } from 'viem';
import { bridgeAsset, getChain, type ChainConfig } from '../../../shared/chains';
import { formatToken } from '../../../shared/format';
import type { BridgeInfo, TicketLeg, TradeTicket } from '../../../shared/panel';
import {
  effectivePreset,
  type ChainSettings,
  type GlobalSettings,
} from '../../../shared/settings/defaults';
import { isSolana } from '../../../shared/solana';
import { hasEvm, type EvmAccount } from '../../../shared/wallet';
import { erc20Abi } from '../../chain/abis';
import {
  bridgeDestination,
  outsidePassword,
  tokenContractBlock,
  type BridgeDestination,
} from '../bridge-to';
import { tokenReceived } from '../receipts';
import {
  BRIDGE_SLIPPAGE_BPS,
  RELAY_DEPOSITORY,
  followBridge,
  relayRule,
  relayTokenRule,
  type BridgeQuote,
  type TokenBridgeQuote,
} from '../relay';
import type { Routed } from '../routing';
import { buildTx, type VenueCtx } from '../types';
import { type EngineCore, type EngineDeps, type TicketState, TradeError, shortErr } from './core';
import { minOutAfter } from './trading';
import { contractAt } from './transfers';

interface BridgeRequest {
  fromChainId: number;
  toChainId: number;
  amount: string;
  fromWalletId: string;
  /** One of the user's wallets to pay, or an address typed for it: exactly one of the two. */
  toWalletId?: string | undefined;
  toAddress?: string | undefined;
}

type Stable = ChainConfig['stablecoins'][number];

/** Slippage on the swap into a chain's bridge asset (bridgeVia): a deep stablecoin pool. */
const VIA_SLIPPAGE_BPS = 100;
/** The most that swap may give up against the coin's own price; above it Nesty refuses. */
const VIA_MAX_IMPACT_BPS = 300;
/** Seconds the swap and the approval add to the bridge's own estimate. */
const VIA_EXTRA_S = 4;
/**
 * Gas kept for the approval and the deposit after the swap, both measured when sent: the
 * swap waits until the wallet covers them, so its output never sits short of the bridge.
 */
const VIA_AFTER_SWAP_GAS = 250_000n;
const VIA_DEADLINE_S = 10 * 60;
const RECEIPT_WAIT_MS = 90_000;

/** Everything a bridge through the chain's bridge asset carries from its checks to its run. */
interface ViaBridge {
  req: BridgeRequest;
  from: EvmAccount;
  to: BridgeDestination;
  own: Address[];
  chain: ChainConfig;
  cs: ChainSettings;
  gs: GlobalSettings;
  ctx: VenueCtx;
  amount: bigint;
  nativeUsd: number;
  via: Stable;
}

/**
 * Bridges native from an EVM chain, to another or to Solana, through Relay, then follows
 * the payout. Where Relay holds none of the chain's coin (bridgeVia), the coin is swapped
 * into the chain's bridge asset first and that is deposited. Bridges from Solana are
 * SolBridgeFlow's.
 */
export class BridgeFlow {
  private readonly d: EngineDeps;

  constructor(private readonly core: EngineCore) {
    this.d = core.d;
  }

  /** The sending wallet, and who the payout goes to on the destination chain. */
  private async bridgeWallets(req: BridgeRequest) {
    if (req.fromChainId === req.toChainId)
      throw new TradeError('unsupported_chain', 'Pick two different chains.');
    if (!getChain(req.toChainId) && !isSolana(req.toChainId))
      throw new TradeError('unsupported_chain');
    const accounts = await this.d.vault.listAccounts();
    const evm = accounts.filter(hasEvm);
    const from = evm.find((a) => a.id === req.fromWalletId);
    if (!from) throw new TradeError('not_found', 'Wallet not found.');
    const to = bridgeDestination(req, accounts);
    if (to.outside) await this.outsideBlock(req.toChainId, to.recipient);
    return { from, to, own: evm.map((a) => a.address) };
  }

  /** An outside address must be one that can hold what it is paid: no token contract. */
  private async outsideBlock(toChainId: number, recipient: string): Promise<void> {
    if (isSolana(toChainId)) {
      const block = await this.d.solanaRecipient?.(recipient);
      if (block) throw new TradeError('blocked', block);
      return;
    }
    const { ctx } = await this.core.context(toChainId);
    const { tokenSymbol } = await contractAt(ctx.client, recipient as Address);
    if (tokenSymbol) throw tokenContractBlock(tokenSymbol);
  }

  /** Refused when a new Solana wallet would be paid too little to exist. */
  private async payoutCheck(toChainId: number, to: BridgeDestination, minOut: bigint) {
    if (!isSolana(toChainId)) return;
    if (!this.d.solanaPayout) throw new TradeError('unsupported_chain');
    const block = await this.d.solanaPayout(to.recipient, minOut);
    if (block) throw new TradeError('insufficient_funds', block);
  }

  /** Relay's quote for the chain's own coin. */
  private async relayQuote(
    req: BridgeRequest,
    from: EvmAccount,
    to: BridgeDestination,
    amount: bigint,
  ): Promise<BridgeQuote> {
    const q = await this.d.relay
      .quote({
        user: from.address,
        recipient: to.recipient,
        fromChainId: req.fromChainId,
        toChainId: req.toChainId,
        amount,
      })
      .catch((e: unknown) => {
        throw new TradeError('no_route', e instanceof Error ? e.message : undefined);
      });
    await this.payoutCheck(req.toChainId, to, q.minOut);
    return q;
  }

  /** Relay's quote for `amount` of the chain's bridge asset. */
  private async tokenQuote(
    req: BridgeRequest,
    from: EvmAccount,
    to: BridgeDestination,
    token: Address,
    amount: bigint,
  ): Promise<TokenBridgeQuote> {
    const q = await this.d.relay
      .quoteToken({
        user: from.address,
        recipient: to.recipient,
        fromChainId: req.fromChainId,
        toChainId: req.toChainId,
        token,
        amount,
      })
      .catch((e: unknown) => {
        throw new TradeError('no_route', e instanceof Error ? e.message : undefined);
      });
    await this.payoutCheck(req.toChainId, to, q.minOut);
    return q;
  }

  /**
   * The swap from the chain's coin into its bridge asset: the best of Nesty's own pools,
   * refused when it gives up more than VIA_MAX_IMPACT_BPS against the coin's price.
   */
  private async viaRoute(
    ctx: VenueCtx,
    via: Stable,
    amount: bigint,
    nativeUsd: number | null | Promise<number | null>,
  ): Promise<Routed> {
    const sym = ctx.chain.nativeCurrency.symbol;
    const [[route], usd] = await Promise.all([
      this.d.routing.best(ctx, via.address, 'buy', [amount], { own: true }),
      nativeUsd,
    ]);
    if (!route || route.out <= 0n || route.venue.funding?.(ctx, route.pool))
      throw new TradeError('no_route', `No pool swaps ${sym} into ${via.symbol}.`);
    if (usd !== null) {
      const worth = Number(formatEther(amount)) * usd;
      const out = Number(formatUnits(route.out, via.decimals));
      if (out < worth * (1 - VIA_MAX_IMPACT_BPS / 10_000))
        throw new TradeError(
          'no_route',
          `Swapping this much ${sym} into ${via.symbol} costs more than ${VIA_MAX_IMPACT_BPS / 100}%. Try a smaller amount.`,
        );
    }
    return route;
  }

  async bridgeQuote(req: BridgeRequest): Promise<{
    amountOut: string;
    minOut: string;
    slippageBps: number;
    feeUsd: number | null;
    timeEstimateS: number | null;
    amountInUsd: number | null;
  }> {
    const { from, to } = await this.bridgeWallets(req);
    const { chain, ctx } = await this.core.context(req.fromChainId);
    const amount = parseEther(req.amount);
    const price = this.d.prices.nativeUsd(ctx).catch(() => null);
    const worth = (usd: number | null) => (usd !== null ? Number(formatEther(amount)) * usd : null);
    const via = bridgeAsset(chain);
    if (via) {
      const route = await this.viaRoute(ctx, via, amount, price);
      const [q, nativeUsd] = await Promise.all([
        this.tokenQuote(req, from, to, via.address, route.out),
        price,
      ]);
      const amountInUsd = worth(nativeUsd);
      // What the swap gives up against the coin's price is part of the cost.
      const swapUsd =
        amountInUsd !== null
          ? Math.max(0, amountInUsd - Number(formatUnits(route.out, via.decimals)))
          : 0;
      const swapMin = minOutAfter(route.out, 0, VIA_SLIPPAGE_BPS);
      return {
        amountOut: q.amountOut.toString(),
        // Relay's least for the swap's least: both slippages taken.
        minOut: ((q.minOut * swapMin) / route.out).toString(),
        slippageBps: BRIDGE_SLIPPAGE_BPS + VIA_SLIPPAGE_BPS,
        feeUsd: q.feeUsd !== null ? q.feeUsd + swapUsd : null,
        timeEstimateS: q.timeEstimateS !== null ? q.timeEstimateS + VIA_EXTRA_S : null,
        amountInUsd,
      };
    }
    const [q, nativeUsd] = await Promise.all([this.relayQuote(req, from, to, amount), price]);
    return {
      amountOut: q.amountOut.toString(),
      minOut: q.minOut.toString(),
      slippageBps: BRIDGE_SLIPPAGE_BPS,
      feeUsd: q.feeUsd,
      timeEstimateS: q.timeEstimateS,
      amountInUsd: worth(nativeUsd),
    };
  }

  async bridge(
    req: BridgeRequest & {
      confirmed: boolean;
      /** The password, for an outside address above the confirmation amount. */
      password?: string | undefined;
      /** Set only by the website's approval window, which asked for the password itself. */
      passwordChecked?: boolean | undefined;
    },
  ): Promise<TradeTicket> {
    const { from, to, own } = await this.bridgeWallets(req);
    const { chain, cs, gs, ctx } = await this.core.context(req.fromChainId);
    const amount = parseEther(req.amount);
    if (amount <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');

    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    if (nativeUsd === null)
      throw new TradeError('limit_exceeded', 'USD price unavailable, cannot check limits.');
    const usd = Number(formatEther(amount)) * nativeUsd;
    if (usd > gs.maxUsdPerTx)
      throw new TradeError(
        'limit_exceeded',
        `${usd.toFixed(2)} > ${gs.maxUsdPerTx} per transaction.`,
      );
    if (to.outside) await outsidePassword(this.d.vault, req, usd, gs.confirmAboveUsd);
    else if (usd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `${usd.toFixed(2)}`);

    const via = bridgeAsset(chain);
    if (via)
      return this.bridgeVia({ req, from, to, own, chain, cs, gs, ctx, amount, nativeUsd, via });

    // Always a fresh quote right before signing; checkQuote() pins the shape.
    const q = await this.relayQuote(req, from, to, amount);

    const legs: TicketLeg[] = [
      {
        walletId: from.id,
        walletName: from.name,
        kind: 'bridge',
        status: 'queued',
        amountIn: amount.toString(),
      },
    ];
    const st = this.core.newTicket('bridge', chain, legs);
    const info = this.bridgeInfo(req, to, amount, q);
    st.ticket.bridge = info;
    const vctx = this.core.validationCtx(chain, from.address, own, {
      maxValue: this.core.usdToWei(gs.maxUsdPerTx, nativeUsd),
      extraContracts: new Map([
        ...this.d.extraContracts(chain.id),
        [RELAY_DEPOSITORY.toLowerCase(), relayRule],
      ]),
    });
    void (async () => {
      const ok = await this.core.execute(st, 0, {
        chain,
        cs,
        gs,
        wallet: from,
        tx: q.tx,
        vctx,
        kind: 'deposit',
        // A contract call quoted by an outside API: always measured, never a static guess.
        simulate: true,
      });
      if (ok)
        await followBridge(
          this.d.relay,
          info,
          q.statusPath,
          () => this.core.update(st),
          this.d.now,
        );
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  private bridgeInfo(
    req: BridgeRequest,
    to: BridgeDestination,
    amount: bigint,
    q: { amountOut: bigint; requestId: string },
  ): BridgeInfo {
    return {
      toChainId: req.toChainId,
      amountIn: amount.toString(),
      amountOut: q.amountOut.toString(),
      recipientName: to.name,
      recipient: to.recipient,
      ...(to.outside ? { outside: true } : {}),
      requestId: q.requestId,
      relayStatus: 'waiting',
    };
  }

  /**
   * From a chain whose coin Relay does not hold (bridgeVia): the coin is swapped into the
   * chain's bridge asset on Nesty's own pools, the depository approved for exactly what
   * arrived, and that deposited. Each is its own transaction; the ticket's first leg stays
   * the deposit. The swap and Relay are both quoted before anything is sent, so nothing is
   * swapped for a bridge that would refuse it.
   */
  private async bridgeVia(b: ViaBridge): Promise<TradeTicket> {
    const { req, from, to, chain, amount, via } = b;
    const route = await this.viaRoute(b.ctx, via, amount, b.nativeUsd);
    const q = await this.tokenQuote(req, from, to, via.address, route.out);

    const legs: TicketLeg[] = [
      {
        walletId: from.id,
        walletName: from.name,
        kind: 'bridge',
        status: 'queued',
        amountIn: amount.toString(),
      },
      {
        walletId: from.id,
        walletName: from.name,
        kind: 'step',
        note: `${chain.nativeCurrency.symbol} → ${via.symbol}`,
        status: 'queued',
      },
    ];
    const st = this.core.newTicket('bridge', chain, legs);
    const info = this.bridgeInfo(req, to, amount, q);
    st.ticket.bridge = info;
    void this.runVia(st, info, b, route);
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /** The swap, the approval when needed, then the deposit and its payout. */
  private async runVia(st: TicketState, info: BridgeInfo, b: ViaBridge, route: Routed) {
    const { req, from, to, own, chain, cs, gs, ctx, amount, via } = b;
    const deposit = st.ticket.legs[0] as TicketLeg;
    // Once the swap landed: what of the bridge asset is in the wallet.
    let held: bigint | null = null;
    const stays = (raw: bigint) =>
      `The ${formatToken(raw, via.decimals)} ${via.symbol} stays in your wallet.`;
    const fail = (error: string) => {
      deposit.status = 'failed';
      deposit.error = held === null ? error : `${error} ${stays(held)}`;
      this.core.update(st);
    };
    const landed = async (leg: TicketLeg | undefined) => {
      if (!leg?.hash) return null;
      const r = await ctx.client
        .waitForTransactionReceipt({
          hash: leg.hash,
          pollingInterval: 500,
          timeout: RECEIPT_WAIT_MS,
        })
        .catch(() => null);
      return r?.status === 'success' ? r : null;
    };
    const rules = new Map([
      ...this.d.extraContracts(chain.id),
      [RELAY_DEPOSITORY.toLowerCase(), relayTokenRule(via.address)],
    ]);
    try {
      // 1) The coin into the bridge asset.
      const tx = await buildTx(route.venue, ctx, route.pool, 'buy', {
        wallet: from.address,
        amountIn: amount,
        minOut: minOutAfter(route.out, 0, VIA_SLIPPAGE_BPS),
        deadline: BigInt(Math.floor(this.d.now() / 1000) + VIA_DEADLINE_S),
      });
      const swapped = await this.core.execute(st, 1, {
        chain,
        cs,
        gs,
        wallet: from,
        tx,
        vctx: this.core.validationCtx(
          chain,
          from.address,
          own,
          { token: via.address, maxValue: this.core.usdToWei(gs.maxUsdPerTx, b.nativeUsd) },
          { ctx, venueId: route.venue.id, pool: route.pool },
        ),
        kind: 'swap',
        simulate: true,
        gate: this.viaGate(chain, cs, ctx, from, amount),
      });
      const step = st.ticket.legs[1];
      if (!swapped)
        return fail(
          step?.error ?? `Could not swap ${chain.nativeCurrency.symbol} into ${via.symbol}.`,
        );
      const receipt = await landed(step);
      if (!receipt) return fail(`The swap into ${via.symbol} did not confirm.`);
      const got = tokenReceived(receipt, via.address, from.address);
      if (got <= 0n) return fail(`No ${via.symbol} arrived from the swap.`);
      held = got;

      // 2) Relay again, for exactly what arrived.
      const q = await this.tokenQuote(req, from, to, via.address, got);
      info.amountOut = q.amountOut.toString();
      info.requestId = q.requestId;

      // 3) The depository's allowance for exactly that, unless it already has it.
      const allowance = await ctx.client.readContract({
        address: via.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [from.address, RELAY_DEPOSITORY],
      });
      if (allowance < got) {
        st.ticket.legs.push({
          walletId: from.id,
          walletName: from.name,
          kind: 'approve',
          note: `Approve ${via.symbol}`,
          status: 'queued',
        });
        const i = st.ticket.legs.length - 1;
        const approved = await this.core.execute(st, i, {
          chain,
          cs,
          gs,
          wallet: from,
          tx: {
            to: via.address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [RELAY_DEPOSITORY, got],
            }),
            value: 0n,
          },
          vctx: this.core.validationCtx(chain, from.address, own, {
            token: via.address,
            maxApproval: got,
            maxValue: 0n,
            extraContracts: rules,
          }),
          kind: 'approve',
          simulate: true,
        });
        const leg = st.ticket.legs[i];
        if (!approved) return fail(leg?.error ?? `The ${via.symbol} approval failed.`);
        if (!(await landed(leg))) return fail(`The ${via.symbol} approval did not confirm.`);
      }

      // 4) The deposit, then its payout.
      const ok = await this.core.execute(st, 0, {
        chain,
        cs,
        gs,
        wallet: from,
        tx: q.tx,
        vctx: this.core.validationCtx(chain, from.address, own, {
          maxValue: 0n,
          extraContracts: rules,
        }),
        kind: 'deposit',
        simulate: true,
      });
      if (!ok) {
        deposit.error = `${deposit.error ?? 'Deposit failed.'} ${stays(got)}`;
        this.core.update(st);
        return;
      }
      await followBridge(this.d.relay, info, q.statusPath, () => this.core.update(st), this.d.now);
    } catch (e) {
      fail(e instanceof TradeError ? (e.detail ?? 'No bridge route.') : shortErr(e));
    }
  }

  /**
   * The swap's check before it is sent: the wallet must cover the amount, the swap's gas
   * and gas for the approval and deposit after it.
   */
  private viaGate(
    chain: ChainConfig,
    cs: ChainSettings,
    ctx: VenueCtx,
    wallet: EvmAccount,
    amount: bigint,
  ): Promise<(gasLimit: bigint) => string | null> {
    return Promise.all([
      ctx.client.getBalance({ address: wallet.address }),
      this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now()),
    ]).then(
      ([balance, fees]) =>
        (gasLimit: bigint) => {
          const need = amount + (gasLimit + VIA_AFTER_SWAP_GAS) * fees.maxFeePerGas;
          const sym = chain.nativeCurrency.symbol;
          return balance < need
            ? `Insufficient balance: needs ${formatToken(need, 18)} ${sym} with gas for the swap, approval and deposit, has ${formatToken(balance, 18)}`
            : null;
        },
      (e: unknown) => () => `Balance check failed: ${shortErr(e)}`,
    );
  }
}
