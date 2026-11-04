import { formatUnits, parseUnits, type Address } from 'viem';
import { getChain } from '../../shared/chains';
import type { BridgeQuoteView } from '../../shared/messages';
import type { BridgeInfo, TicketLeg, TradeTicket } from '../../shared/panel';
import { SOLANA, isSolana, type SolAddress } from '../../shared/solana';
import {
  bridgeDestination,
  outsidePassword,
  tokenContractBlock,
  type BridgeDestination,
} from '../trade/bridge-to';
import { TradeError } from '../trade/engine/core';
import {
  BRIDGE_SLIPPAGE_BPS,
  followBridge,
  type RelayClient,
  type SolBridgeQuote,
} from '../trade/relay';
import { DEPOSIT_UNITS, relayDepositNative } from './relay';
import type { SolRpc } from './rpc';
import type { SolanaDeps, SolanaService, SolWallet } from './service';
import { LOSING, SOL_AMOUNT, networkFee, recipientKind, solSendBlock } from './transfers';
import { validateRelayDeposit, type RelayDepositContext } from './validator';

interface BridgeRequest {
  toChainId: number;
  amount: string;
  fromWalletId: string;
  /** One of the user's wallets to pay, or an address typed for it: exactly one of the two. */
  toWalletId?: string | undefined;
  toAddress?: string | undefined;
}

const sol = (lamports: bigint) => formatUnits(lamports, SOLANA.nativeCurrency.decimals);

/**
 * Bridges SOL to an EVM chain through Relay: one deposit_native into Relay's vault, checked
 * like every Solana transaction before it is signed, then the payout followed. Also tells
 * bridges from EVM chains whether a payout is enough for a new Solana wallet to exist.
 */
export class SolBridgeFlow {
  constructor(
    private readonly core: SolanaService,
    private readonly d: SolanaDeps,
  ) {}

  async quote(req: BridgeRequest): Promise<BridgeQuoteView> {
    const amount = this.amountOf(req);
    const { from, to } = await this.wallets(req);
    const [q, solUsd] = await Promise.all([
      this.relayQuote(req, from, to, amount),
      this.core.price.usd().catch(() => null),
    ]);
    return {
      amountOut: q.amountOut.toString(),
      minOut: q.minOut.toString(),
      slippageBps: BRIDGE_SLIPPAGE_BPS,
      feeUsd: q.feeUsd,
      timeEstimateS: q.timeEstimateS,
      amountInUsd: solUsd !== null ? Number(sol(amount)) * solUsd : null,
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
    const startedAt = this.d.now();
    const amount = this.amountOf(req);
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const { from, to } = await this.wallets(req);
    const solUsd = await this.core.transfers.solUsd();
    const usd = Number(sol(amount)) * solUsd;
    if (usd > gs.maxUsdPerTx)
      throw new TradeError(
        'limit_exceeded',
        `${usd.toFixed(2)} > ${gs.maxUsdPerTx} per transaction.`,
      );
    if (to.outside) await outsidePassword(this.d.vault, req, usd, gs.confirmAboveUsd);
    else if (usd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `${usd.toFixed(2)}`);

    // The deposit moves SOL out like a transfer: what the wallet keeps must be zero or
    // enough to exist. Checked now, and again right before it is sent.
    const rpc = this.core.rpcFor(ss);
    const fee = networkFee(ss);
    const minBalance = await this.core.transfers.rentExempt(rpc, 0);
    const shortfall = async (r: SolRpc) =>
      solSendBlock(await r.getBalance(from.solana), amount, fee, minBalance);
    const block = await shortfall(rpc);
    if (block) throw new TradeError('insufficient_funds', block);

    // Always a fresh quote right before signing; checkSolanaQuote() pins the shape.
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
    const st = this.core.newTicket('bridge', legs);
    st.startedAt = startedAt;
    st.ticket.nativeUsd = solUsd;
    const info: BridgeInfo = {
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
    const limits = this.core.limits(
      gs,
      { usd: solUsd, decimals: SOLANA.nativeCurrency.decimals },
      solUsd,
    );
    const ctx: RelayDepositContext = {
      wallet: from.solana,
      amount,
      id: q.depositId,
      maxSpend: limits.maxSpend,
      maxPriorityLamports: limits.maxPriorityLamports,
    };
    const relay = this.relay();
    void this.core.runLeg(st, 0, {
      wallet: from,
      instructions: [relayDepositNative(from.solana, amount, q.depositId)],
      units: DEPOSIT_UNITS,
      validate: (ixs) => validateRelayDeposit(ixs, ctx),
      shortfall,
      onConfirmed: () =>
        void followBridge(relay, info, q.statusPath, () => this.core.update(st), this.d.now),
      gs,
      ss,
    });
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /**
   * Why Relay may not pay `minOut` lamports to `recipient`, or null when it may: an address
   * that holds nothing yet must be paid at least the rent exemption to exist.
   */
  async payoutBlock(recipient: SolAddress, minOut: bigint): Promise<string | null> {
    const rpc = this.core.rpcFor(await this.d.settings.getSolana());
    const [acc, minBalance] = await Promise.all([
      rpc.getAccount(recipient),
      this.core.transfers.rentExempt(rpc, 0),
    ]);
    if (acc || minOut >= minBalance) return null;
    return `A new Solana wallet needs at least ${sol(minBalance)} SOL to exist: bridge a little more.`;
  }

  /** Why an outside Solana address may not be paid at all, or null when it may. */
  async recipientBlock(recipient: SolAddress): Promise<string | null> {
    const acc = await this.core.rpcFor(await this.d.settings.getSolana()).getAccount(recipient);
    return LOSING.has(recipientKind(recipient, acc).kind)
      ? 'This address is not a wallet: funds sent there are lost.'
      : null;
  }

  /** The amount typed, in lamports. Bridges from Solana go to an EVM chain. */
  private amountOf(req: BridgeRequest): bigint {
    if (isSolana(req.toChainId))
      throw new TradeError('unsupported_chain', 'Pick two different chains.');
    if (!getChain(req.toChainId)) throw new TradeError('unsupported_chain');
    if (!SOL_AMOUNT.test(req.amount))
      throw new TradeError('blocked', 'SOL has at most 9 decimals.');
    const amount = parseUnits(req.amount, SOLANA.nativeCurrency.decimals);
    if (amount <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');
    return amount;
  }

  /** The wallet sending SOL, and who is paid on the EVM chain. */
  private async wallets(req: BridgeRequest): Promise<{ from: SolWallet; to: BridgeDestination }> {
    const accounts = await this.d.vault.listAccounts();
    const from = accounts.find((a) => a.id === req.fromWalletId);
    if (!from) throw new TradeError('not_found', 'Wallet not found.');
    if (!from.solana) throw new TradeError('not_found', `${from.name} has no Solana address.`);
    const to = bridgeDestination(req, accounts);
    if (to.outside && this.d.evmTokenAt) {
      const symbol = await this.d.evmTokenAt(req.toChainId, to.recipient as Address);
      if (symbol) throw tokenContractBlock(symbol);
    }
    return { from: { ...from, solana: from.solana }, to };
  }

  private relayQuote(
    req: BridgeRequest,
    from: SolWallet,
    to: BridgeDestination,
    amount: bigint,
  ): Promise<SolBridgeQuote> {
    return this.relay()
      .quoteFromSolana({
        user: from.solana,
        recipient: to.recipient as Address,
        toChainId: req.toChainId,
        amount,
      })
      .catch((e: unknown) => {
        throw new TradeError('no_route', e instanceof Error ? e.message : undefined);
      });
  }

  private relay(): RelayClient {
    if (!this.d.relay) throw new TradeError('no_route', 'Bridging is unavailable.');
    return this.d.relay;
  }
}
