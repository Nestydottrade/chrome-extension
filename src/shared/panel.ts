import type { Address, Hex } from 'viem';
import type { PriorityLevel, WalletGroup } from './settings/defaults';

/** Amounts are decimal strings of raw integer units (bigint does not cross messaging). */
export interface PanelWallet {
  id: string;
  name: string;
  /** EVM address, or the wallet's Solana address on Solana. */
  address: string;
  primary: boolean;
  selected: boolean;
  native: string;
  token: string;
  /** Tokens bought through Nesty and still open, with their native cost (for PnL). */
  cost?: { tokens: string; costWei: string };
}

/** Solana: a token a coin is bought with (and sold for) in place of SOL. */
export interface PayCurrency {
  mint: string;
  symbol: string;
  decimals: number;
  /** Priced at $1, so the USD quick-buy amounts are the token amounts themselves. */
  stable: boolean;
}

export interface PanelState {
  locked: boolean;
  wallets: PanelWallet[];
  nativeUsd: number | null;
  /**
   * Set when the coin is bought with a token (e.g. USDC for a coin paired with it): wallet
   * `native` balances, `nativeUsd` and the quick-buy amounts are then in that token.
   */
  pay?: PayCurrency;
  chain: {
    quickBuyAmounts: string[];
    quickSellBps: number[];
    slippageBps: number;
    priority: PriorityLevel;
    priorityGwei: { low: string; medium: string; high: string };
    customPriorityGwei: string;
    /** False on first-come-first-served sequencers, where a priority fee does nothing. */
    priorityApplies: boolean;
    /** `configured`: a private RPC is set, so the toggle can actually take effect. */
    mev: { supported: boolean; enabled: boolean; configured: boolean; reason?: string };
    /** Buys above this measured tax are refused. 10 000 = off. */
    maxTaxBps: number;
  };
  global: {
    hotkeysEnabled: boolean;
    multiWalletMode: 'each' | 'split';
    /** Saved wallet groups, in Alt + 1–9 order. */
    groups: WalletGroup[];
    confirmAboveUsd: number;
    maxUsdPerTx: number;
    maxUsdPerClick: number;
    priceImpactWarnBps: number;
    priceImpactDangerBps: number;
    quoteRefreshMs: number;
  };
}

export interface QuoteView {
  amountIn: string;
  amountOut: string;
  priceImpactBps: number | null;
  venue: string;
}

export interface TaxView {
  buyBps: number;
  /** Null when the sell part could not be measured. */
  sellBps: number | null;
  /** The simulated sell reverted. */
  sellFails: boolean;
}

export interface QuoteSet {
  buys: (QuoteView | null)[];
  sells: (QuoteView | null)[];
  /** USD value of one whole token, if known. */
  tokenUsd: number | null;
  venue: string | null;
  /** Why there is no route, when it is known (e.g. a full launchpad curve). */
  idle: string | null;
  /**
   * Token tax measured by simulating a buy then a sell on the quoted pool (transfer tax
   * plus any venue tax). Null until measured, or when it could not be.
   */
  tax: TaxView | null;
  /** The tax probe ran but could not measure (e.g. the RPC cannot simulate). */
  taxUnknown: boolean;
  fetchedAt: number;
}

export type LegStatus =
  'queued' | 'sending' | 'submitted' | 'confirmed' | 'failed' | 'skipped' | 'blocked';

export interface TicketLeg {
  walletId: string;
  walletName: string;
  /** 'step': a conversion around the trade (e.g. ETH → VIRTUAL for a Virtuals curve). */
  kind: 'approve' | 'swap' | 'transfer' | 'cancel' | 'bridge' | 'step';
  /** Shown instead of the wallet name, e.g. "ETH → VIRTUAL". */
  note?: string;
  status: LegStatus;
  hash?: Hex;
  /** Solana: the transaction signature (base58), in place of `hash`. */
  sig?: string;
  nonce?: number;
  /** Raw amount in (native wei for buys, token units for sells). */
  amountIn?: string;
  error?: string;
  /** Ms from the click to the RPC accepting the transaction. */
  sentMs?: number;
  /**
   * Where sentMs went: routing before the checks, balance check + simulation,
   * nonce + signing, and the RPC accepting it.
   */
  phases?: { prepMs: number; checkMs: number; signMs: number; sendMs: number };
  /** Ms from sending to seeing the receipt. */
  confirmMs?: number;
  /** Network fee paid (wei), from the receipt. */
  feeWei?: string;
  /** Raw amount received: token units for buys, native wei for sells. */
  amountOut?: string;
  /**
   * Sent, but queued behind this nonce, which never reached the network (an earlier
   * send was refused). Filling it ("unstick") lets this one through.
   */
  waitingNonce?: number;
}

/**
 * Ms from the click until the transaction was signed and ready to send: Nesty's own part
 * of sentMs. The rest (`phases.sendMs`) is the network accepting it.
 */
export function readyMs(leg: TicketLeg): number | undefined {
  const p = leg.phases;
  return p ? p.prepMs + p.checkMs + p.signMs : undefined;
}

/** Trade settings in force when the ticket was sent. */
export interface TicketSettings {
  slippageBps: number;
  /** Absent where the priority fee does not apply (Arbitrum-based chains). */
  priority?: { level: string; gwei: string };
  /** Solana: the priority fee paid per transaction, in SOL. */
  prioritySol?: { level: string; sol: string };
  /** Absent where private sending is not offered. */
  mev?: boolean;
}

export interface BlockedAction {
  label: string;
  ok: boolean;
  reason?: string;
}

/**
 * The decoded actions a signer sent back with its refusal. The website's signer is Nesty,
 * which checks each transaction again and says which action it refused.
 */
export function refusedActions(e: unknown): BlockedAction[] | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const actions = (e as { actions?: unknown }).actions;
  return Array.isArray(actions) && actions.length > 0 ? (actions as BlockedAction[]) : undefined;
}

/** Decoded actions as they cross to the website, checked field by field and kept short. */
export function readBlockedActions(v: unknown): BlockedAction[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > 32) return undefined;
  const out: BlockedAction[] = [];
  for (const a of v as unknown[]) {
    if (typeof a !== 'object' || a === null) return undefined;
    const { label, ok, reason } = a as { label?: unknown; ok?: unknown; reason?: unknown };
    if (typeof label !== 'string' || typeof ok !== 'boolean') return undefined;
    if (reason !== undefined && typeof reason !== 'string') return undefined;
    out.push({
      label: label.slice(0, 200),
      ok,
      ...(reason !== undefined && { reason: reason.slice(0, 300) }),
    });
  }
  return out;
}

export interface TradeTicket {
  id: string;
  kind: 'buy' | 'sell' | 'distribute' | 'collect' | 'bridge' | 'send';
  chainId: number;
  token?: Address;
  /** Solana: the token's mint (base58), in place of `token`. */
  mint?: string;
  symbol?: string;
  status: 'working' | 'done' | 'partial' | 'failed' | 'blocked';
  legs: TicketLeg[];
  createdAt: number;
  explorer: string;
  blocked?: BlockedAction[];
  bridge?: BridgeInfo;
  /** Pool label, e.g. "Uniswap v3 · 0.3% via USDC". */
  route?: string;
  settings?: TicketSettings;
  /** Native price in USD at send time, for the USD figures in history. */
  nativeUsd?: number;
  /**
   * Solana: what the trade paid or received in place of SOL. Native amounts in the legs,
   * and `nativeUsd`, are then in this token.
   */
  pay?: PayCurrency;
  /** Token decimals, for amounts in history. */
  decimals?: number;
  /** Send: the outside address the funds went to (0x…, or base58 on Solana). */
  recipient?: string;
}

/** Cross-chain transfer via Relay (native asset to native asset). */
export interface BridgeInfo {
  toChainId: number;
  /** Raw amounts, each in its chain's native units (wei, or lamports on Solana). */
  amountIn: string;
  amountOut: string;
  /** The wallet paid, or the address shortened when it is none of the user's. */
  recipientName: string;
  /** The address paid on the destination chain. */
  recipient?: string;
  /** Not one of the user's wallets. */
  outside?: boolean;
  /** Relay's id for the request. */
  requestId: string;
  /** Relay status: waiting → pending → success | failure | refund. */
  relayStatus: string;
  /** Destination tx, once filled: a hash, or a signature on Solana. */
  outHash?: string;
}
