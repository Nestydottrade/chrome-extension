import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import type { BlockedAction, BridgeInfo } from '../../shared/panel';
import { sanitizeLabel } from '../../shared/sanitize';
import { SOLANA_CHAIN_ID, isSolana, type SolAddress } from '../../shared/solana';
import { COMPUTE_BUDGET_PROGRAM } from '../solana/address';
import { DEPOSIT_NATIVE, RELAY_SOLANA_PROGRAM, relayDepositNative } from '../solana/relay';
import {
  isOwn,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from './validator';

/**
 * Bridging via Relay (relay.link). Relay quotes a single deposit into its depository on
 * the origin chain; a solver then pays the recipient on the destination chain.
 *
 * On EVM chains the depository is the same CREATE2 address on every supported chain
 * (identical bytecode checked on all five) and its source is verified on Basescan. The only
 * call Nesty makes to it is depositNative(depositor, id). On Solana it is Relay's
 * depository program, and the only instruction is deposit_native (see solana/relay.ts).
 */
const RELAY_API = 'https://api.relay.link';
export const RELAY_DEPOSITORY: Address = getAddress('0x4cd00e387622c35bddb9b4c962c136462338bc31');
const NATIVE = '0x0000000000000000000000000000000000000000';
/** Relay's address for SOL. */
export const SOLANA_NATIVE = '11111111111111111111111111111111';
/**
 * Slippage asked of Relay (basis points). Left unset, Relay picks its own (2% between
 * Robinhood and BSC). Payouts land within seconds, so 0.5% leaves room for the price to
 * move meanwhile; Relay commits to at least the resulting minimum or refunds the deposit.
 */
export const BRIDGE_SLIPPAGE_BPS = 50;
/** How long a bridge is followed once its deposit landed, and how often. */
const FOLLOW_MS = 15 * 60_000;
const FOLLOW_POLL_MS = 3_000;
const FINAL: readonly string[] = ['success', 'failure', 'refund'];
const Wei = z.string().regex(/^[0-9]+$/);
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A Solana signature: 64 bytes in base58. */
const SOL_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** Relay's status path for a request. */
const STATUS_PATH = /^\/intents\/status(?:\/v\d)?\?requestId=(0x[0-9a-fA-F]{64})$/;

const depositoryAbi = parseAbi(['function depositNative(address depositor, bytes32 id) payable']);

const EvmTxData = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  chainId: z.number(),
});
const SolTxData = z.object({
  instructions: z.array(
    z.object({
      programId: z.string(),
      keys: z.array(
        z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
      ),
      // Hex, without 0x.
      data: z.string(),
    }),
  ),
});

const QuoteSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      requestId: z.string().optional(),
      items: z.array(
        z.object({
          data: z.union([EvmTxData, SolTxData]),
          check: z.object({ endpoint: z.string() }).optional(),
        }),
      ),
    }),
  ),
  fees: z
    .record(z.string(), z.object({ amountUsd: z.string().optional() }).nullable().optional())
    .optional(),
  details: z.object({
    recipient: z.string(),
    timeEstimate: z.number().optional(),
    currencyOut: z.object({
      currency: z.object({ chainId: z.number(), address: z.string() }),
      amount: Wei,
      minimumAmount: Wei,
    }),
  }),
});
export type RelayQuote = z.infer<typeof QuoteSchema>;

/** What a quote says in either direction: amounts, fees and the request to follow. */
export interface QuoteTerms {
  amountIn: bigint;
  amountOut: bigint;
  /** The least Relay commits to pay out. */
  minOut: bigint;
  feeUsd: number | null;
  timeEstimateS: number | null;
  /** Relay's id for the request (not the deposit's id). */
  requestId: Hex;
  /** Relay status path for this request, e.g. /intents/status?requestId=0x… */
  statusPath: string;
}

/** From an EVM chain: the deposit transaction. */
export interface BridgeQuote extends QuoteTerms {
  tx: { to: Address; data: Hex; value: bigint };
}

/** From Solana: the deposit's id; the instruction is built around it (relayDepositNative). */
export interface SolBridgeQuote extends QuoteTerms {
  depositId: Uint8Array;
}

export class RelayError extends Error {}

export interface RelayClient {
  /** From an EVM chain, to another or to Solana (`recipient` is base58 then). */
  quote(p: {
    user: Address;
    recipient: string;
    fromChainId: number;
    toChainId: number;
    amount: bigint;
  }): Promise<BridgeQuote>;
  /** From Solana, to an EVM chain. */
  quoteFromSolana(p: {
    user: SolAddress;
    recipient: Address;
    toChainId: number;
    amount: bigint;
  }): Promise<SolBridgeQuote>;
  /** Where a request stands, and its payout on `toChainId` once there is one. */
  status(statusPath: string, toChainId: number): Promise<{ status: string; outHash?: string }>;
}

export function createRelayClient(fetchFn: typeof fetch = fetch): RelayClient {
  const call = async (path: string, init?: RequestInit) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchFn(`${RELAY_API}${path}`, {
        ...init,
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      // Relay's own wording is outside text: cleaned, shortened and labelled as the bridge's.
      const said = typeof json?.message === 'string' ? sanitizeLabel(json.message, 120) : '';
      if (!res.ok)
        throw new RelayError(
          said ? `Bridge service: ${said}` : `Bridge service error ${res.status}`,
        );
      return json;
    } finally {
      clearTimeout(t);
    }
  };

  const quote = async (body: Record<string, string | number>): Promise<RelayQuote> => {
    const raw = await call('/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        tradeType: 'EXACT_INPUT',
        slippageTolerance: String(BRIDGE_SLIPPAGE_BPS),
      }),
    });
    const q = QuoteSchema.safeParse(raw);
    if (!q.success) throw new RelayError('Unexpected quote format');
    return q.data;
  };

  return {
    async quote(p) {
      const q = await quote({
        user: p.user,
        recipient: p.recipient,
        originChainId: p.fromChainId,
        destinationChainId: p.toChainId,
        originCurrency: NATIVE,
        destinationCurrency: isSolana(p.toChainId) ? SOLANA_NATIVE : NATIVE,
        amount: p.amount.toString(),
      });
      return checkQuote(q, p);
    },
    async quoteFromSolana(p) {
      const q = await quote({
        user: p.user,
        recipient: p.recipient,
        originChainId: SOLANA_CHAIN_ID,
        destinationChainId: p.toChainId,
        originCurrency: SOLANA_NATIVE,
        destinationCurrency: NATIVE,
        amount: p.amount.toString(),
      });
      return checkSolanaQuote(q, p);
    },
    async status(statusPath, toChainId) {
      if (!STATUS_PATH.test(statusPath)) throw new RelayError('Unexpected status path');
      const raw = (await call(statusPath)) as { status?: string; txHashes?: unknown } | null;
      // Payouts on the destination chain: a hash there, or a signature on Solana.
      const format = isSolana(toChainId) ? SOL_SIGNATURE : BYTES32;
      const hashes: unknown[] = Array.isArray(raw?.txHashes) ? raw.txHashes : [];
      const out = hashes.find((h): h is string => typeof h === 'string' && format.test(h));
      return { status: String(raw?.status ?? 'unknown'), ...(out ? { outHash: out } : {}) };
    },
  };
}

/**
 * What both directions check: one transaction step, the recipient we asked for, the native
 * coin of the destination chain paid out, and no more slippage than we asked for.
 */
function checkTerms(
  q: RelayQuote,
  p: { recipient: string; toChainId: number; amount: bigint },
): { item: RelayQuote['steps'][number]['items'][number]; terms: QuoteTerms } {
  const items = q.steps.flatMap((s) => s.items.map((i) => ({ step: s, item: i })));
  if (q.steps.length !== 1 || items.length !== 1)
    throw new RelayError('Quote has unexpected steps');
  const { step, item } = items[0] as (typeof items)[number];
  if (step.kind !== 'transaction') throw new RelayError('Quote step is not a transaction');

  const toSolana = isSolana(p.toChainId);
  const r = q.details.recipient;
  // base58 is case-sensitive: a Solana recipient must match exactly.
  const sameRecipient = toSolana
    ? r === p.recipient
    : EVM_ADDRESS.test(r) &&
      EVM_ADDRESS.test(p.recipient) &&
      isAddressEqual(r as Address, p.recipient as Address);
  if (!sameRecipient) throw new RelayError('Quote recipient differs from your wallet');
  const out = q.details.currencyOut;
  if (out.currency.chainId !== p.toChainId)
    throw new RelayError('Quote pays out on a different chain');
  if (out.currency.address.toLowerCase() !== (toSolana ? SOLANA_NATIVE : NATIVE))
    throw new RelayError('Quote pays out a token, not the native coin');

  const amountOut = BigInt(out.amount);
  const minOut = BigInt(out.minimumAmount);
  // One unit of slack for rounding: Relay floors the minimum.
  const floor = (amountOut * BigInt(10_000 - BRIDGE_SLIPPAGE_BPS)) / 10_000n;
  if (minOut === 0n || minOut + 1n < floor)
    throw new RelayError('Quote allows more slippage than requested');

  // The request is followed by Relay's id for it, which is not the deposit's id.
  const endpoint = item.check?.endpoint;
  const fromPath = endpoint ? STATUS_PATH.exec(endpoint)?.[1] : undefined;
  if (endpoint && !fromPath) throw new RelayError('Unexpected status path');
  const requestId = fromPath ?? step.requestId;
  if (!requestId || !BYTES32.test(requestId)) throw new RelayError('Quote has no request id');
  if (step.requestId !== undefined && step.requestId.toLowerCase() !== requestId.toLowerCase())
    throw new RelayError('Quote names two requests');

  // Relay lists sub-fees (relayerGas, relayerService) next to their totals; add the
  // two top-level ones: origin gas + relayer.
  const feeUsd =
    q.fees && (q.fees.gas || q.fees.relayer)
      ? Number(q.fees.gas?.amountUsd ?? 0) + Number(q.fees.relayer?.amountUsd ?? 0)
      : null;
  return {
    item,
    terms: {
      amountIn: p.amount,
      amountOut,
      minOut,
      feeUsd: feeUsd !== null && Number.isFinite(feeUsd) ? feeUsd : null,
      timeEstimateS: q.details.timeEstimate ?? null,
      requestId: requestId as Hex,
      statusPath: endpoint ?? `/intents/status?requestId=${requestId}`,
    },
  };
}

/**
 * From an EVM chain. Accepts only the shape Nesty expects: one deposit transaction on the
 * origin chain, into the depository, for exactly the requested amount, crediting our own
 * wallet, with the destination recipient we asked for and no more slippage than we asked for.
 */
export function checkQuote(
  q: RelayQuote,
  p: { user: Address; recipient: string; fromChainId: number; toChainId: number; amount: bigint },
): BridgeQuote {
  const { item, terms } = checkTerms(q, p);
  const d = item.data;
  if ('instructions' in d || d.chainId !== p.fromChainId)
    throw new RelayError('Quote is for a different chain');
  if (!EVM_ADDRESS.test(d.to) || !isAddressEqual(d.to as Address, RELAY_DEPOSITORY)) {
    throw new RelayError('Quote targets an unknown contract');
  }
  if (BigInt(d.value) !== p.amount) throw new RelayError('Quote value differs from the amount');
  let call;
  try {
    call = decodeFunctionData({ abi: depositoryAbi, data: d.data as Hex });
  } catch {
    throw new RelayError('Quote calldata is not a native deposit');
  }
  const [depositor] = call.args;
  if (!isAddressEqual(depositor, p.user))
    throw new RelayError('Deposit is not credited to your wallet');
  return { ...terms, tx: { to: RELAY_DEPOSITORY, data: d.data as Hex, value: BigInt(d.value) } };
}

/** Bytes from hex, with or without 0x; null when it is not hex. */
function hexBytes(s: string): Uint8Array | null {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  return Uint8Array.from({ length: h.length / 2 }, (_, i) =>
    parseInt(h.slice(2 * i, 2 * i + 2), 16),
  );
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * From Solana. Accepts one transaction holding only Relay's deposit_native (compute budget
 * aside, which Nesty sets itself): for exactly the requested amount, from and credited to
 * our wallet, into Relay's vault, with the recipient we asked for. The deposit is then built
 * by Nesty around the quoted id, never taken from the quote.
 */
export function checkSolanaQuote(
  q: RelayQuote,
  p: { user: SolAddress; recipient: Address; toChainId: number; amount: bigint },
): SolBridgeQuote {
  const { item, terms } = checkTerms(q, p);
  const d = item.data;
  if (!('instructions' in d)) throw new RelayError('Quote is for a different chain');
  const deposits = d.instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM);
  const ix = deposits[0];
  if (deposits.length !== 1 || !ix) throw new RelayError('Quote is not a single deposit');
  if (ix.programId !== RELAY_SOLANA_PROGRAM)
    throw new RelayError('Quote targets an unknown program');
  const data = hexBytes(ix.data);
  if (!data || data.length !== 48 || !DEPOSIT_NATIVE.every((b, i) => data[i] === b))
    throw new RelayError('Quote instruction is not a native deposit');
  const depositId = data.slice(16);
  const want = relayDepositNative(p.user, p.amount, depositId);
  if (!sameBytes(data, want.data)) throw new RelayError('Quote value differs from the amount');
  if (ix.keys[2]?.pubkey !== p.user) throw new RelayError('Deposit is not credited to your wallet');
  const sameKeys =
    ix.keys.length === want.keys.length &&
    ix.keys.every((k, i) => {
      const w = want.keys[i];
      return k.pubkey === w?.pubkey && k.isSigner === w.isSigner && k.isWritable === w.isWritable;
    });
  if (!sameKeys) throw new RelayError('Quote deposit has unexpected accounts');
  return { ...terms, depositId };
}

/** Validator rule for the depository: only depositNative crediting one of your wallets. */
export const relayRule: ExtraContractRule = {
  label: 'Bridge',
  validate(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
    let call;
    try {
      call = decodeFunctionData({ abi: depositoryAbi, data: tx.data });
    } catch {
      return [{ label: 'Bridge call', ok: false, reason: 'Only native deposits are allowed' }];
    }
    const [depositor] = call.args;
    const label = `Bridge deposit for ${depositor.slice(0, 6)}…`;
    if (!isOwn(ctx, depositor) || !isAddressEqual(depositor, ctx.from)) {
      return [{ label, ok: false, reason: 'Deposit is not credited to the sending wallet' }];
    }
    if (tx.value === 0n) return [{ label, ok: false, reason: 'Empty deposit' }];
    return [{ label, ok: true }];
  },
};

/**
 * Follows a bridge once its deposit landed: asks Relay until the payout is filled, refunded
 * or failed (15 minutes at most), updating `info` and calling `changed` when it moves.
 */
export async function followBridge(
  relay: RelayClient,
  info: BridgeInfo,
  statusPath: string,
  changed: () => void,
  now: () => number,
): Promise<void> {
  const started = now();
  while (now() - started < FOLLOW_MS) {
    await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
    const r = await relay.status(statusPath, info.toChainId).catch(() => null);
    if (!r) continue;
    const moved = r.status !== info.relayStatus || (r.outHash && r.outHash !== info.outHash);
    info.relayStatus = r.status;
    if (r.outHash) info.outHash = r.outHash;
    if (moved) changed();
    if (FINAL.includes(r.status)) return;
  }
}
