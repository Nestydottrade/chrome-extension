import { formatEther, parseEther, type Address } from 'viem';
import { getChain } from '../../../shared/chains';
import type { TicketLeg, TradeTicket } from '../../../shared/panel';
import { isSolana } from '../../../shared/solana';
import { hasEvm, type EvmAccount } from '../../../shared/wallet';
import {
  bridgeDestination,
  outsidePassword,
  tokenContractBlock,
  type BridgeDestination,
} from '../bridge-to';
import {
  BRIDGE_SLIPPAGE_BPS,
  RELAY_DEPOSITORY,
  followBridge,
  relayRule,
  type BridgeQuote,
} from '../relay';
import { type EngineCore, type EngineDeps, TradeError } from './core';
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

/**
 * Bridges native from an EVM chain, to another or to Solana, through Relay, then follows
 * the payout. Bridges from Solana are SolBridgeFlow's.
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

  /** Relay's quote. Refused when a new Solana wallet would be paid too little to exist. */
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
    if (isSolana(req.toChainId)) {
      if (!this.d.solanaPayout) throw new TradeError('unsupported_chain');
      const block = await this.d.solanaPayout(to.recipient, q.minOut);
      if (block) throw new TradeError('insufficient_funds', block);
    }
    return q;
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
    const { ctx } = await this.core.context(req.fromChainId);
    const amount = parseEther(req.amount);
    const [q, nativeUsd] = await Promise.all([
      this.relayQuote(req, from, to, amount),
      this.d.prices.nativeUsd(ctx).catch(() => null),
    ]);
    return {
      amountOut: q.amountOut.toString(),
      minOut: q.minOut.toString(),
      slippageBps: BRIDGE_SLIPPAGE_BPS,
      feeUsd: q.feeUsd,
      timeEstimateS: q.timeEstimateS,
      amountInUsd: nativeUsd !== null ? Number(formatEther(amount)) * nativeUsd : null,
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
    const info = {
      toChainId: req.toChainId,
      amountIn: amount.toString(),
      amountOut: q.amountOut.toString(),
      recipientName: to.name,
      recipient: to.recipient,
      ...(to.outside ? { outside: true } : {}),
      requestId: q.requestId,
      relayStatus: 'waiting',
    };
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
}
