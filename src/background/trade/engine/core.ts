import {
  encodeFunctionData,
  formatEther,
  getAddress,
  maxUint256,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { getChain, type ChainConfig } from '../../../shared/chains';
import type { ApprovalView } from '../../../shared/messages';
import {
  refusedActions,
  type BlockedAction,
  type TicketLeg,
  type TicketSettings,
  type TradeTicket,
} from '../../../shared/panel';
import { formatToken } from '../../../shared/format';
import { sanitizeLabel } from '../../../shared/sanitize';
import {
  effectivePreset,
  type ChainSettings,
  type GlobalSettings,
} from '../../../shared/settings/defaults';
import { hasEvm, type EvmAccount, type WalletAccount } from '../../../shared/wallet';
import { erc20Abi } from '../../chain/abis';
import type { SettingsStore } from '../../settings';
import type { Vault } from '../../vault/vault';
import type { AggregatorCheck } from '../aggregator-check';
import { bumpFees, staticGas, type FeeCache, type Fees, type GasKind } from '../fees';
import type { NonceManager } from '../nonce';
import type { PriceService } from '../prices';
import { feePaid, nativeUnwrapped, tokenReceived } from '../receipts';
import type { TaxService } from '../tax';
import type { Routed, Routing } from '../routing';
import type { PoolRef, TxDraft, VenueCtx } from '../types';
import { nestyRouterRule } from '../nesty-router';
import type { RelayClient } from '../relay';
import { vaultSigner, type EvmSigner, type SignerWallet, type TxPurpose } from '../signer';
import { PERMIT2, UNISWAP } from '../uniswap/addresses';
import { validateTx, type ExtraContractRule, type ValidationContext } from '../validator';

export class TradeError extends Error {
  constructor(
    readonly code:
      | 'unsupported_chain'
      | 'no_route'
      | 'needs_confirmation'
      | 'needs_password'
      | 'limit_exceeded'
      | 'tax_too_high'
      | 'insufficient_funds'
      | 'not_found'
      | 'blocked'
      | 'rpc',
    readonly detail?: string,
    /** The decoded actions, when a check of the transaction refused one of them. */
    readonly actions?: BlockedAction[],
  ) {
    super(code);
  }
}

/**
 * Blocks a leg whose signer refused it and said which decoded action: the website's signer
 * is Nesty, which checks each transaction again. Any other error leaves the leg as it is.
 */
export function markRefused(ticket: TradeTicket, leg: TicketLeg, e: unknown): void {
  const actions = refusedActions(e);
  if (!actions) return;
  leg.status = 'blocked';
  ticket.blocked = actions;
}

export interface EngineDeps {
  vault: Vault;
  /** Signs transactions and Permit2 messages; the vault's keys when not set. */
  signer?: EvmSigner;
  settings: SettingsStore;
  routing: Routing;
  tax: TaxService;
  /** Checks an aggregator route's fill before it is used (see AggregatorCheck). */
  aggregatorCheck?: Pick<AggregatorCheck, 'trusted'>;
  fees: FeeCache;
  nonces: NonceManager;
  prices: PriceService;
  /** Read client (custom RPC first). */
  client: (chain: ChainConfig, cs: ChainSettings) => PublicClient;
  /** Submits a signed transaction; picks the endpoint(s) for the chain and MEV settings. */
  broadcast: (chain: ChainConfig, cs: ChainSettings, raw: Hex) => Promise<Hash>;
  fetchJson?: (url: string) => Promise<unknown>;
  /** Aggregator API access (KyberSwap fallback routes). */
  aggregator?: VenueCtx['aggregator'];
  extraContracts: (chainId: number) => ReadonlyMap<string, ExtraContractRule>;
  notify: (ticket: TradeTicket, tabId?: number) => void;
  relay: RelayClient;
  /**
   * Why Relay may not pay `minOut` lamports to a Solana `recipient` (a new wallet must get
   * enough to exist), or null when it may. Bridges to Solana are refused without it.
   */
  solanaPayout?: (recipient: string, minOut: bigint) => Promise<string | null>;
  /** Why an outside Solana address may not be paid at all (no wallet there), or null. */
  solanaRecipient?: (recipient: string) => Promise<string | null>;
  /** Resolves on the next block for the chain (WebSocket) or after timeoutMs. */
  nextBlock?: (chainId: number, timeoutMs: number) => Promise<void>;
  now: () => number;
}

interface SentTx {
  chainId: number;
  walletId: string;
  from: Address;
  nonce: number;
  tx: TxDraft;
  gas: bigint;
  fees: Fees;
  token?: Address | undefined;
  fundingAsset?: Address | undefined;
  maxApproval?: bigint | undefined;
  rules?: ValidationContext['extraContracts'];
  sentAt: number;
}

export interface TicketState {
  ticket: TradeTicket;
  tabId?: number | undefined;
  sent: Map<number, SentTx>; // by leg index
  /** Click time (or ticket creation), the start of each leg's click → sent timing. */
  startedAt: number;
}

const RECEIPT_POLL_MS = 1_500;
/** Finished tickets stay in memory this long (late receipts, history), then are dropped. */
const TICKET_TTL_MS = 60 * 60_000;
/** Any ticket, even one with a transaction still pending, is dropped after this. */
const TICKET_MAX_AGE_MS = 24 * 60 * 60_000;
const RECEIPT_TIMEOUT_MS = 5 * 60_000;
/** Tokens checked for approvals at most; each costs wallets × spenders reads. */
const MAX_APPROVAL_TOKENS = 40;
/** At or above this an allowance reads as unlimited (some tokens store max minus spent). */
const UNLIMITED = maxUint256 / 2n;

/** A sent transaction still unmined after this is checked for a nonce gap ahead of it. */
const GAP_CHECK_MS = 4_000;
/** Lowest gas limit an unsimulated transaction is sent with when capped by the balance. */
const MIN_UNSIMULATED_GAS = 200_000n;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What each wallet of a buy spends: `per` each, or with a variance, up to that much less at
 * random, so wallets that buy together do not all spend the same. Never more than `per`, so
 * the limits checked on it hold. One wallet buys exactly `per`.
 */
export function walletAmounts(
  per: bigint,
  wallets: number,
  varianceBps: number,
  random: () => number = Math.random,
): bigint[] {
  if (wallets < 2 || varianceBps <= 0) return Array.from({ length: wallets }, () => per);
  return Array.from({ length: wallets }, () => {
    const cut = BigInt(Math.floor(random() * (varianceBps + 1)));
    return per - (per * cut) / 10_000n;
  });
}

/** Typical gas of a transaction sent without simulation, on chains with a mempool. */
const TYPICAL_GAS: Record<GasKind, bigint> = {
  swap: 250_000n,
  approve: 60_000n,
  transfer: 21_000n,
  tokenTransfer: 65_000n,
  deposit: 60_000n,
  routed: 500_000n,
};

/**
 * What `gas` is expected to cost: the use at base fee + tip, not the cap. Simulated limits
 * carry a 30% buffer; static ones are worst cases (typical sizes are used on mempool
 * chains, where they would overstate the fee most).
 */
export function expectedFeeWei(
  chain: ChainConfig,
  fees: Fees,
  base: bigint | null,
  gas: bigint,
  simulated: boolean,
  kind: GasKind,
): bigint {
  const perGas =
    base === null || base + fees.maxPriorityFeePerGas > fees.maxFeePerGas
      ? fees.maxFeePerGas
      : base + fees.maxPriorityFeePerGas;
  const units = simulated
    ? (gas * 10n) / 13n
    : chain.feeModel === 'arbitrum'
      ? gas
      : gas < TYPICAL_GAS[kind]
        ? gas
        : TYPICAL_GAS[kind];
  return units * perGas;
}

/**
 * The validator's context for one transaction: the chain's allowlisted contracts, the
 * pool's own (a per-token curve), and the Nesty Router's rule.
 */
export function validationContext(
  d: Pick<EngineDeps, 'extraContracts' | 'routing' | 'now'>,
  chain: ChainConfig,
  from: Address,
  own: readonly Address[],
  extra: Partial<ValidationContext> & { maxValue: bigint },
  route?: { ctx: VenueCtx; venueId: string; pool: PoolRef },
): ValidationContext {
  const rules = new Map(d.extraContracts(chain.id));
  const venue = route ? d.routing.venue(route.venueId) : undefined;
  for (const [addr, rule] of (route && venue?.poolRules?.(route.ctx, route.pool)) || []) {
    rules.set(addr.toLowerCase(), rule);
  }
  // Its rule only passes funded curve trades (it needs `fundingAsset`).
  if (chain.nestyRouter)
    rules.set(chain.nestyRouter.toLowerCase(), nestyRouterRule(chain.nestyRouter));
  return {
    chain,
    from,
    ownWallets: own,
    router: UNISWAP[chain.id]?.universalRouter,
    extraContracts: rules,
    nowS: Math.floor(d.now() / 1000),
    ...extra,
  };
}

/** Why the expected fee is above the user's gas limit (USD), or null. */
export function gasFeeRefusal(
  feeWei: bigint,
  nativeUsd: number | null,
  maxGasUsd: number,
  symbol: string,
): string | null {
  // Unknown price: the trade's own USD limits already refused anything they could not check.
  if (nativeUsd === null) return null;
  const usd = Number(formatEther(feeWei)) * nativeUsd;
  if (usd <= maxGasUsd) return null;
  return `Gas fee about $${usd.toFixed(2)} (${formatToken(feeWei, 18)} ${symbol}) is above your gas limit of $${maxGasUsd}. Lower the priority fee or raise the limit in Settings.`;
}

/** The chain, its settings and the venue context that quotes and trades on it run with. */
export async function chainContext(
  d: Pick<EngineDeps, 'settings' | 'client' | 'fetchJson' | 'aggregator' | 'now'>,
  chainId: number,
): Promise<{ chain: ChainConfig; cs: ChainSettings; gs: GlobalSettings; ctx: VenueCtx }> {
  const chain = getChain(chainId);
  if (!chain) throw new TradeError('unsupported_chain');
  const [cs, gs] = await Promise.all([d.settings.getChain(chainId), d.settings.get()]);
  const ctx: VenueCtx = {
    chain,
    client: d.client(chain, cs),
    fetchJson: gs.usePoolIndex ? d.fetchJson : undefined,
    aggregator: gs.useAggregator ? d.aggregator : undefined,
    now: d.now,
  };
  return { chain, cs, gs, ctx };
}

export function shortErr(e: unknown): string {
  const err = e as { shortMessage?: string; details?: unknown };
  let msg = e instanceof Error ? (err.shortMessage ?? e.message) : String(e);
  // Nodes put the actual reason in `details`; the RPC code alone often maps to a generic
  // "Missing or invalid parameters."
  if (e instanceof Error && typeof err.details === 'string' && /invalid param/i.test(msg))
    msg = err.details;
  if (/insufficient funds/i.test(msg)) return 'Insufficient balance for gas';
  // Never echo an address back into the ticket; the rest is a node's text: clean it.
  // Long hex (raw revert data) is cut to its ends: in full it only stretches the layout.
  const line =
    msg
      .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, '0x…')
      .replace(/0x([0-9a-fA-F]{6})[0-9a-fA-F]{12,}([0-9a-fA-F]{6})/g, '0x$1…$2')
      .split('\n')[0] ?? '';
  return sanitizeLabel(line, 160) || 'error';
}

/**
 * What every flow shares: wallet and chain context, tickets, the validator → simulate →
 * sign → send path for one transaction, receipts, and token metadata.
 */
export class EngineCore {
  private readonly tickets = new Map<string, TicketState>();
  private readonly symbols = new Map<string, string>();
  private readonly decimals = new Map<string, number>();
  readonly signer: EvmSigner;

  constructor(readonly d: EngineDeps) {
    this.signer = d.signer ?? vaultSigner(d.vault);
  }

  // ── context helpers ───────────────────────────────────────────────────────

  context(chainId: number) {
    return chainContext(this.d, chainId);
  }

  async wallets(ids: readonly string[]): Promise<EvmAccount[]> {
    const all = await this.d.vault.listAccounts();
    // A wallet listed twice must still trade once.
    const picked = [...new Set(ids)]
      .map((id) => all.find((a) => a.id === id))
      .filter((a): a is WalletAccount => !!a);
    if (picked.length === 0) throw new TradeError('not_found', 'No wallet selected.');
    const evm = picked.filter(hasEvm);
    if (evm.length === 0)
      throw new TradeError('not_found', 'Wallets imported from a Solana key have no EVM address.');
    return evm;
  }

  validationCtx(
    chain: ChainConfig,
    from: Address,
    own: readonly Address[],
    extra: Partial<ValidationContext> & { maxValue: bigint },
    route?: { ctx: VenueCtx; venueId: string; pool: PoolRef },
  ): ValidationContext {
    return validationContext(this.d, chain, from, own, extra, route);
  }

  usdToWei(usd: number, nativeUsd: number): bigint {
    return parseEther((usd / nativeUsd).toFixed(18));
  }

  // ── tickets ───────────────────────────────────────────────────────────────

  /** The page's click time when plausible, else now (clocks are the same machine). */
  clickTime(clickedAt: number | undefined): number {
    const now = this.d.now();
    return clickedAt !== undefined && clickedAt <= now && now - clickedAt < 30_000
      ? clickedAt
      : now;
  }

  /**
   * Drops old tickets so a long-lived worker (a WebSocket RPC keeps it alive) does not
   * grow without bound. Pending transactions keep theirs for speed-up and cancel.
   */
  private prune(): void {
    const now = this.d.now();
    for (const [id, st] of this.tickets) {
      const age = now - st.ticket.createdAt;
      const pending = st.ticket.legs.some((l) =>
        ['queued', 'sending', 'submitted'].includes(l.status),
      );
      if (age > TICKET_MAX_AGE_MS || (!pending && age > TICKET_TTL_MS)) this.tickets.delete(id);
    }
  }

  newTicket(
    kind: TradeTicket['kind'],
    chain: ChainConfig,
    legs: TicketLeg[],
    tabId?: number,
    token?: Address,
    symbol?: string,
  ): TicketState {
    this.prune();
    const ticket: TradeTicket = {
      id: crypto.randomUUID(),
      kind,
      chainId: chain.id,
      status: 'working',
      legs,
      createdAt: this.d.now(),
      explorer: chain.explorer.url,
      ...(token ? { token } : {}),
      ...(symbol ? { symbol } : {}),
    };
    const st: TicketState = { ticket, tabId, sent: new Map(), startedAt: ticket.createdAt };
    this.tickets.set(ticket.id, st);
    return st;
  }

  update(st: TicketState): void {
    const legs = st.ticket.legs.filter((l) => l.kind !== 'approve');
    const done = legs.filter((l) => l.status === 'confirmed').length;
    const bad = legs.filter((l) => ['failed', 'blocked', 'skipped'].includes(l.status)).length;
    const open = legs.length - done - bad;
    if (open === 0) {
      st.ticket.status =
        done === legs.length
          ? 'done'
          : done === 0
            ? st.ticket.blocked
              ? 'blocked'
              : 'failed'
            : 'partial';
    }
    const b = st.ticket.bridge;
    if (b && st.ticket.status === 'done') {
      // The origin deposit confirmed; the bridge is done once Relay paid out.
      if (b.relayStatus === 'failure' || b.relayStatus === 'refund') st.ticket.status = 'failed';
      else if (b.relayStatus !== 'success') st.ticket.status = 'working';
    }
    this.d.notify(structuredClone(st.ticket), st.tabId);
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private sign(
    wallet: SignerWallet,
    chainId: number,
    nonce: number,
    tx: TxDraft,
    gas: bigint,
    fees: Fees,
    purpose: TxPurpose | undefined,
  ): Promise<Hex> {
    return this.signer.transaction(
      wallet,
      {
        chainId,
        nonce,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
      purpose,
    );
  }

  /**
   * Validate → (simulate) → sign → send for one transaction. Returns the leg update.
   * Nothing is signed unless the validator passes.
   */
  async execute(
    st: TicketState,
    legIndex: number,
    p: {
      chain: ChainConfig;
      cs: ChainSettings;
      gs: GlobalSettings;
      wallet: EvmAccount;
      tx: TxDraft;
      vctx: ValidationContext;
      kind: GasKind;
      simulate: boolean;
      /** How the transaction was built, for a signer that checks it again (the website's). */
      purpose?: TxPurpose;
      /**
       * Pre-send check fetched alongside the simulation, then applied to the gas limit
       * that will be signed. A reason skips the leg.
       */
      gate?: Promise<(gasLimit: bigint) => string | null>;
    },
  ): Promise<boolean> {
    const leg = st.ticket.legs[legIndex];
    if (!leg) return false;
    const verdict = validateTx(p.tx, p.vctx);
    if (!verdict.ok) {
      leg.status = 'blocked';
      leg.error = verdict.actions.find((a) => !a.ok)?.reason ?? 'Blocked';
      st.ticket.blocked = verdict.actions;
      this.update(st);
      return false;
    }

    const client = this.d.client(p.chain, p.cs);
    const tCheck = this.d.now();
    let gas = staticGas(p.chain, p.kind);
    // The gate and the simulation are independent round trips: run them together.
    const [check, sim] = await Promise.all([
      p.gate ?? null,
      p.simulate
        ? client
            .estimateGas({
              account: p.wallet.address,
              to: p.tx.to,
              data: p.tx.data,
              value: p.tx.value,
            })
            .then(
              (est) => ({ est }),
              (e: unknown) => ({ err: e }),
            )
        : null,
    ]);
    if (sim && 'est' in sim) gas = (sim.est * 13n) / 10n;
    // Checked against the gas limit actually signed: the static fallback is a worst case
    // (3M gas on Arbitrum-style chains) and would refuse wallets that can pay. When the
    // simulation failed, only the value itself is checked, so an unfunded wallet still
    // gets the clearer reason.
    let refusal = check?.(sim && 'err' in sim ? 0n : gas) ?? null;
    if (refusal && check && !sim) {
      // Simulation is off, so `gas` is the static worst case. Measure the real limit
      // before refusing: one extra round trip, only for wallets near empty.
      const est = await client
        .estimateGas({ account: p.wallet.address, to: p.tx.to, data: p.tx.data, value: p.tx.value })
        .catch(() => null);
      if (est !== null) {
        gas = (est * 13n) / 10n;
        refusal = check(gas);
      }
    }
    if (refusal) {
      leg.status = 'skipped';
      leg.error = refusal;
      this.update(st);
      return false;
    }
    if (sim && 'err' in sim) {
      leg.status = 'failed';
      leg.error = `Simulation failed: ${shortErr(sim.err)}`;
      this.update(st);
      return false;
    }

    const preset = effectivePreset(p.cs);
    try {
      const fees = await this.d.fees.fees(p.chain, client, preset, this.d.now());
      if (!sim && p.chain.feeModel === 'arbitrum') {
        // Not simulated (an approval right behind a buy, or a sell behind its approval): the
        // static limit is a worst case, and the node refuses any transaction whose limit ×
        // max fee exceeds the balance. Cap it at what the wallet covers; real use is far less.
        const balance = await client.getBalance({ address: p.wallet.address });
        const affordable = balance > p.tx.value ? (balance - p.tx.value) / fees.maxFeePerGas : 0n;
        if (affordable < MIN_UNSIMULATED_GAS) {
          leg.status = 'skipped';
          leg.error = `Insufficient balance for gas: has ${formatToken(balance, 18)} ${p.chain.nativeCurrency.symbol}`;
          this.update(st);
          return false;
        }
        if (affordable < gas) gas = affordable;
      }
      // The USD limits cover the trade, not gas: a priority-fee typo or a base-fee spike must
      // not cost more than the user's gas limit. Judged on the expected fee, not the cap.
      const feeRefusal = gasFeeRefusal(
        await this.expectedFee(p.chain, client, fees, gas, !!sim, p.kind),
        await this.d.prices
          .nativeUsd({ chain: p.chain, client, now: this.d.now })
          .catch(() => null),
        p.gs.maxGasUsd,
        p.chain.nativeCurrency.symbol,
      );
      if (feeRefusal) {
        leg.status = 'skipped';
        leg.error = feeRefusal;
        this.update(st);
        return false;
      }
      const tSign = this.d.now();
      leg.status = 'sending';
      this.update(st);
      let tSend = tSign;
      const { nonce, result: hash } = await this.d.nonces.signAndSend(
        p.chain.id,
        p.wallet.address,
        (n) => this.sign(p.wallet, p.chain.id, n, p.tx, gas, fees, p.purpose),
        (raw) => {
          tSend = this.d.now();
          return this.d.broadcast(p.chain, p.cs, raw);
        },
      );
      const sent = { nonce, hash };
      const tDone = this.d.now();
      leg.status = 'submitted';
      leg.hash = sent.hash;
      leg.nonce = sent.nonce;
      leg.sentMs = Math.max(0, tDone - st.startedAt);
      leg.phases = {
        prepMs: Math.max(0, tCheck - st.startedAt),
        checkMs: tSign - tCheck,
        signMs: tSend - tSign,
        sendMs: tDone - tSend,
      };
      st.sent.set(legIndex, {
        chainId: p.chain.id,
        walletId: p.wallet.id,
        from: p.wallet.address,
        nonce: sent.nonce,
        tx: p.tx,
        gas,
        fees,
        token: p.vctx.token,
        fundingAsset: p.vctx.fundingAsset,
        maxApproval: p.vctx.maxApproval,
        rules: p.vctx.extraContracts,
        sentAt: this.d.now(),
      });
      this.update(st);
      void this.watch(st, legIndex, p.chain, p.cs);
      return true;
    } catch (e) {
      leg.status = 'failed';
      leg.error = shortErr(e);
      markRefused(st.ticket, leg, e);
      this.update(st);
      return false;
    }
  }

  private async watch(
    st: TicketState,
    legIndex: number,
    chain: ChainConfig,
    cs: ChainSettings,
  ): Promise<void> {
    const leg = st.ticket.legs[legIndex];
    if (!leg) return;
    const client = this.d.client(chain, cs);
    const started = this.d.now();
    let gapCheckedAt = started;
    while (this.d.now() - started < RECEIPT_TIMEOUT_MS) {
      // With a WebSocket RPC this wakes on each new block; otherwise it is a plain poll.
      await (this.d.nextBlock
        ? this.d.nextBlock(chain.id, RECEIPT_POLL_MS)
        : sleep(RECEIPT_POLL_MS));
      const hash = leg.hash;
      if (!hash || leg.status !== 'submitted') return;
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) {
        leg.status = receipt.status === 'success' ? 'confirmed' : 'failed';
        if (receipt.status !== 'success') leg.error = 'Reverted on-chain';
        const sent = st.sent.get(legIndex);
        if (sent) leg.confirmMs = Math.max(0, this.d.now() - sent.sentAt);
        leg.feeWei = feePaid(receipt).toString();
        // A sell's native proceeds arrive in its final step when the pool is funded.
        const pays = leg.kind === 'swap' || (leg.kind === 'step' && st.ticket.kind === 'sell');
        if (receipt.status === 'success' && sent && pays) {
          const out = await this.received(st.ticket, sent.from, receipt, client, chain);
          if (out !== null) leg.amountOut = out.toString();
        }
        if (leg.waitingNonce !== undefined) delete leg.waitingNonce;
        this.update(st);
        return;
      }
      if (this.d.now() - gapCheckedAt >= GAP_CHECK_MS) {
        gapCheckedAt = this.d.now();
        await this.checkGap(st, legIndex, client);
      }
    }
    leg.error = 'Not confirmed yet — speed it up or cancel.';
    // It may have been dropped: the next transaction re-reads the nonce from the chain
    // instead of queueing behind a gap that would never fill.
    const sent = st.sent.get(legIndex);
    if (sent) this.d.nonces.reset(chain.id, sent.from);
    this.update(st);
  }

  /**
   * Is this sent transaction queued behind a nonce nobody sent? That happens when an
   * earlier send of a rapid burst was refused: later ones went out regardless.
   * A gap is a mined count below our nonce with nothing pending at it on the node.
   */
  private async checkGap(st: TicketState, legIndex: number, client: PublicClient) {
    const leg = st.ticket.legs[legIndex];
    const sent = st.sent.get(legIndex);
    if (!leg || !sent) return;
    const counts = await Promise.all([
      client.getTransactionCount({ address: sent.from, blockTag: 'latest' }),
      client.getTransactionCount({ address: sent.from, blockTag: 'pending' }),
    ]).catch(() => null);
    if (!counts) return;
    const [mined, pending] = counts;
    const gap = mined < sent.nonce && pending <= mined ? mined : undefined;
    if (gap === leg.waitingNonce) return;
    if (gap === undefined) delete leg.waitingNonce;
    else leg.waitingNonce = gap;
    this.update(st);
  }

  /** What `gas` is expected to cost: the simulated use at base fee + tip, not the cap. */
  private async expectedFee(
    chain: ChainConfig,
    client: PublicClient,
    fees: Fees,
    gas: bigint,
    simulated: boolean,
    kind: GasKind,
  ): Promise<bigint> {
    const base = await this.d.fees.baseFee(chain, client, this.d.now()).catch(() => null);
    return expectedFeeWei(chain, fees, base, gas, simulated, kind);
  }

  /** What a confirmed swap delivered to the wallet, for history. Best effort. */
  private async received(
    t: TradeTicket,
    wallet: Address,
    receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>,
    client: PublicClient,
    chain: ChainConfig,
  ): Promise<bigint | null> {
    if (t.kind === 'buy' && t.token) return tokenReceived(receipt, t.token, wallet);
    if (t.kind !== 'sell') return null;
    const unwrapped = nativeUnwrapped(receipt, chain.wrappedNative);
    if (unwrapped > 0n) return unwrapped;
    // Native pools (Uniswap v4) pay out without an unwrap: use the balance change.
    const [before, after] = await Promise.all([
      client.getBalance({ address: wallet, blockNumber: receipt.blockNumber - 1n }),
      client.getBalance({ address: wallet, blockNumber: receipt.blockNumber }),
    ]).catch(() => [null, null] as const);
    if (before === null || after === null) return null;
    const out = after - before + feePaid(receipt);
    return out > 0n ? out : null;
  }

  private settingsSnapshot(chain: ChainConfig, cs: ChainSettings): TicketSettings {
    const preset = effectivePreset(cs);
    return {
      slippageBps: preset.slippageBps,
      ...(chain.feeModel === 'eip1559'
        ? { priority: { level: cs.priority, gwei: preset.priorityFeeGwei } }
        : {}),
      ...(chain.mev.supported ? { mev: cs.mevEnabled && !!cs.mevRpc } : {}),
    };
  }

  /** Route, settings, price and decimals shown in history. */
  describe(
    st: TicketState,
    ctx: VenueCtx,
    cs: ChainSettings,
    route: Routed,
    nativeUsd: number | null,
  ): void {
    const t = st.ticket;
    t.route = route.pool.label;
    t.settings = this.settingsSnapshot(ctx.chain, cs);
    if (nativeUsd !== null) t.nativeUsd = nativeUsd;
    void this.decimalsOf(ctx, route.pool.token).then((d) => {
      if (d === null) return;
      t.decimals = d;
      this.update(st);
    });
  }

  // ── replacement ───────────────────────────────────────────────────────────

  async replace(
    ticketId: string,
    walletId: string,
    mode: 'speedUp' | 'cancel',
  ): Promise<TradeTicket> {
    const st = this.tickets.get(ticketId);
    if (!st) throw new TradeError('not_found');
    const idx = st.ticket.legs.findIndex(
      (l, i) => l.walletId === walletId && l.status === 'submitted' && st.sent.has(i),
    );
    const sent = st.sent.get(idx);
    const leg = st.ticket.legs[idx];
    if (!sent || !leg) throw new TradeError('not_found', 'No pending transaction for that wallet.');
    const { chain, cs, gs, ctx } = await this.context(sent.chainId);
    const preset = effectivePreset(cs);
    const floor = await this.d.fees.fees(chain, ctx.client, preset, this.d.now());
    const fees = bumpFees(sent.fees, floor);
    const own = (await this.d.vault.listAccounts()).filter(hasEvm).map((a) => a.address);
    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    const tx: TxDraft = mode === 'cancel' ? { to: sent.from, data: '0x', value: 0n } : sent.tx;
    const gas = mode === 'cancel' ? staticGas(chain, 'transfer') : sent.gas;
    const vctx = this.validationCtx(chain, sent.from, own, {
      token: sent.token,
      fundingAsset: sent.fundingAsset,
      maxApproval: sent.maxApproval,
      maxValue: nativeUsd ? this.usdToWei(gs.maxUsdPerTx, nativeUsd) : tx.value,
      // A replayed router call keeps its original deadline; allow it while still valid.
      nowS: Math.floor(this.d.now() / 1000),
    });
    if (sent.rules) vctx.extraContracts = sent.rules;
    if (mode === 'speedUp') {
      // Permits inside the original call were already validated when first signed.
      vctx.maxPermit = BigInt(2) ** BigInt(160) - 1n;
    }
    const verdict = validateTx(tx, vctx);
    if (!verdict.ok) {
      st.ticket.blocked = verdict.actions;
      this.update(st);
      throw new TradeError('rpc', 'Replacement blocked by the safety check.');
    }
    const raw = await this.sign(
      { id: sent.walletId, address: sent.from },
      chain.id,
      sent.nonce,
      tx,
      gas,
      fees,
      { kind: mode === 'cancel' ? 'empty' : 'replace' },
    );
    const hash = await this.d.broadcast(chain, cs, raw);
    st.sent.set(idx, { ...sent, tx, gas, fees });
    leg.hash = hash;
    if (mode === 'cancel') leg.kind = 'cancel';
    delete leg.error;
    this.update(st);
    return structuredClone(st.ticket);
  }

  /**
   * Fills the nonce a wallet's sent transaction is queued behind with an empty transfer to
   * itself, so the queued ones go through. Checked again first: if the gap has closed or
   * something is already pending at that nonce, nothing is sent.
   */
  async unstick(ticketId: string, walletId: string): Promise<TradeTicket> {
    const st = this.tickets.get(ticketId);
    if (!st) throw new TradeError('not_found');
    const idx = st.ticket.legs.findIndex(
      (l, i) => l.walletId === walletId && l.waitingNonce !== undefined && st.sent.has(i),
    );
    const sent = st.sent.get(idx);
    const leg = st.ticket.legs[idx];
    if (!sent || !leg) throw new TradeError('not_found', 'Nothing is stuck for that wallet.');
    const { chain, cs, ctx } = await this.context(sent.chainId);
    const [mined, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: sent.from, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: sent.from, blockTag: 'pending' }),
    ]);
    if (mined >= sent.nonce || pending > mined) {
      // Closed by itself (or by another send) since it was flagged.
      delete leg.waitingNonce;
      this.update(st);
      return structuredClone(st.ticket);
    }
    const own = (await this.d.vault.listAccounts()).filter(hasEvm).map((a) => a.address);
    const tx: TxDraft = { to: sent.from, data: '0x', value: 0n };
    const verdict = validateTx(
      tx,
      this.validationCtx(chain, sent.from, own, {
        maxValue: 0n,
        nowS: Math.floor(this.d.now() / 1000),
      }),
    );
    if (!verdict.ok) throw new TradeError('rpc', 'Unstick blocked by the safety check.');
    const fees = await this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now());
    const raw = await this.sign(
      { id: sent.walletId, address: sent.from },
      chain.id,
      mined,
      tx,
      staticGas(chain, 'transfer'),
      fees,
      { kind: 'empty' },
    );
    await this.d.broadcast(chain, cs, raw);
    // The local count may sit past the gap or before it: read it from the chain next time.
    this.d.nonces.reset(chain.id, sent.from);
    delete leg.waitingNonce;
    this.update(st);
    return structuredClone(st.ticket);
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  /** The only spenders Nesty ever approves on a chain: Permit2 and allowlisted contracts. */
  private spenders(chainId: number): { address: Address; label: string }[] {
    const rules = [...this.d.extraContracts(chainId)].filter(([, r]) => r.approvalSpender);
    return [
      { address: PERMIT2, label: 'Permit2' },
      ...rules.map(([a, r]) => ({ address: getAddress(a), label: r.label })),
    ];
  }

  /** Every non-zero allowance of the given tokens, across all wallets, to those spenders. */
  async approvals(chainId: number, tokens: readonly Address[]): Promise<ApprovalView[]> {
    const { ctx } = await this.context(chainId);
    const wallets = (await this.d.vault.listAccounts()).filter(hasEvm);
    const spenders = this.spenders(chainId);
    const list = [...new Set(tokens.map((t) => getAddress(t)))].slice(0, MAX_APPROVAL_TOKENS);
    const combos = list.flatMap((token) =>
      wallets.flatMap((w) => spenders.map((s) => ({ token, w, s }))),
    );
    if (combos.length === 0) return [];
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: combos.map(
        (c) =>
          ({
            address: c.token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [c.w.address, c.s.address],
          }) as const,
      ),
    });
    const found = combos.flatMap((c, i) => {
      const r = res[i];
      return r?.status === 'success' && r.result > 0n ? [{ ...c, amount: r.result }] : [];
    });
    const held = [...new Set(found.map((f) => f.token))];
    const meta = await ctx.client.multicall({
      allowFailure: true,
      contracts: held.flatMap((token) => [
        { address: token, abi: erc20Abi, functionName: 'symbol' } as const,
        { address: token, abi: erc20Abi, functionName: 'decimals' } as const,
      ]),
    });
    const info = new Map(
      held.map((token, i) => {
        const sym = meta[i * 2];
        const dec = meta[i * 2 + 1];
        return [
          token,
          {
            symbol: sanitizeLabel(sym?.status === 'success' ? String(sym.result) : '') || '?',
            decimals: dec?.status === 'success' ? Number(dec.result) : 18,
          },
        ];
      }),
    );
    return found.map((f) => ({
      walletId: f.w.id,
      walletName: f.w.name,
      token: f.token,
      symbol: info.get(f.token)?.symbol ?? '?',
      decimals: info.get(f.token)?.decimals ?? 18,
      spender: f.s.address,
      spenderLabel: f.s.label,
      amount: f.amount.toString(),
      unlimited: f.amount >= UNLIMITED,
    }));
  }

  /**
   * Sets a wallet's allowance of a token to a spender back to zero. Validated and sent like
   * any transaction; waits up to a minute for the receipt.
   */
  async revoke(
    chainId: number,
    walletId: string,
    token: Address,
    spender: Address,
  ): Promise<{ hash: Hash; confirmed: boolean }> {
    const { chain, cs, ctx } = await this.context(chainId);
    const accounts = (await this.d.vault.listAccounts()).filter(hasEvm);
    const wallet = accounts.find((a) => a.id === walletId);
    if (!wallet) throw new TradeError('not_found', 'No such wallet.');
    const tx: TxDraft = {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }),
      value: 0n,
    };
    const verdict = validateTx(
      tx,
      this.validationCtx(
        chain,
        wallet.address,
        accounts.map((a) => a.address),
        { token, maxApproval: 0n, maxValue: 0n },
      ),
    );
    if (!verdict.ok)
      throw new TradeError('rpc', verdict.actions.find((a) => !a.ok)?.reason ?? 'Blocked.');
    const gas = await ctx.client
      .estimateGas({ account: wallet.address, to: tx.to, data: tx.data, value: 0n })
      .then((g) => (g * 13n) / 10n)
      .catch(() => staticGas(chain, 'approve'));
    const fees = await this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now());
    const { result: hash } = await this.d.nonces.signAndSend(
      chain.id,
      wallet.address,
      (n) => this.sign(wallet, chain.id, n, tx, gas, fees, undefined),
      (raw) => this.d.broadcast(chain, cs, raw),
    );
    const receipt = await ctx.client
      .waitForTransactionReceipt({ hash, timeout: 60_000 })
      .catch(() => null);
    return { hash, confirmed: receipt?.status === 'success' };
  }

  /**
   * Called while the panel is open: refreshes the base fee and the selected wallets'
   * nonces so a click does not wait for those RPC calls.
   */
  async warm(chainId: number, walletIds: readonly string[]): Promise<void> {
    const { chain, cs, ctx } = await this.context(chainId);
    const accounts = (await this.d.vault.listAccounts()).filter(hasEvm);
    const addrs = accounts.filter((a) => walletIds.includes(a.id)).map((a) => a.address);
    await Promise.all([
      this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now()),
      ...addrs.map((a) => this.d.nonces.warm(chain.id, a)),
    ]);
  }

  // ── misc ──────────────────────────────────────────────────────────────────

  async decimalsOf(ctx: VenueCtx, token: Address): Promise<number | null> {
    const key = `${ctx.chain.id}:${token.toLowerCase()}`;
    const hit = this.decimals.get(key);
    if (hit !== undefined) return hit;
    const d = await ctx.client
      .readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
      .then(Number)
      .catch(() => null);
    if (d !== null && Number.isInteger(d) && d >= 0 && d <= 36) {
      this.decimals.set(key, d);
      return d;
    }
    return null;
  }

  /** First trade of a token: the symbol arrives after the ticket; patch it in. */
  fillSymbol(st: TicketState, ctx: VenueCtx, token: Address): void {
    void this.symbolOf(ctx, token).then((sym) => {
      st.ticket.symbol = sym;
      this.update(st);
    });
  }

  /** Cached symbol right away; fetches in the background the first time. */
  symbolNow(ctx: VenueCtx, token: Address): string | undefined {
    const hit = this.symbols.get(`${ctx.chain.id}:${token.toLowerCase()}`);
    if (!hit) void this.symbolOf(ctx, token);
    return hit;
  }

  async symbolOf(ctx: VenueCtx, token: Address): Promise<string> {
    const key = `${ctx.chain.id}:${token.toLowerCase()}`;
    const hit = this.symbols.get(key);
    if (hit) return hit;
    const sym = await ctx.client
      .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
      .then((s) => sanitizeLabel(s, 16))
      .catch(() => '');
    this.symbols.set(key, sym || 'TOKEN');
    return sym || 'TOKEN';
  }
}
