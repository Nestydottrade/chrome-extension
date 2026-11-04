import type { BlockedAction } from '../../shared/panel';
import type { SolAddress } from '../../shared/solana';
import { shortAddress as short } from '../../shared/wallet';
import { createInstructions, type PumpCreate } from '../create/pump';
import { act } from '../trade/actions';
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAddress,
} from './address';
import {
  BUYBACK_FEE_RECIPIENTS,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  TRADE_DATA,
  feeRecipients,
  isSolQuote,
  readRecipients,
  routeCoin,
  routeOk,
  routeVariant,
  tradeAccounts,
  tradeProgram,
  venueLabel,
  type PumpRoute,
  type Side,
} from './pump';
import {
  ATA_CREATE_IDEMPOTENT,
  CU_SET_LIMIT,
  CU_SET_PRICE,
  MAX_COMPUTE_UNITS,
  SYSTEM_TRANSFER,
  TOKEN_CLOSE_ACCOUNT,
  TOKEN_SYNC_NATIVE,
  TOKEN_TRANSFER_CHECKED,
  wsolAccount,
} from './spl';
import { dexModule, type DexVenue } from './dex';
import { RELAY_SOLANA_PROGRAM, relayDepositNative } from './relay';
import type { AccountMeta, Instruction } from './tx';

/**
 * Runs before EVERY Solana signature. Pure and synchronous, like the EVM validator: every
 * instruction must be one Nesty builds for this route, with the accounts derived here
 * again from the wallet and the route. Anything else is rejected.
 */
export interface SolValidationContext {
  wallet: SolAddress;
  /** The token the user asked to trade: the route must end in it. */
  mint: SolAddress;
  /** The route the trade was built on, as read from chain. */
  route: PumpRoute;
  side: Side;
  /** Most the trade may spend, in the pay currency (from the USD limit). */
  maxSpend: bigint;
  /** Most lamports the priority fee may cost (from the max network fee). */
  maxPriorityLamports: bigint;
  /** The pay currency, for amounts in the actions. SOL when absent. */
  payUnit?: { symbol: string; decimals: number };
}

export interface SolValidationResult {
  ok: boolean;
  actions: BlockedAction[];
  /** What the trade spends in the pay currency, as the validator read it. */
  spend: bigint;
  /** The amounts its trade call names: what goes in, and the least it takes back. */
  amountIn: bigint;
  minOut: bigint;
}

function units(raw: bigint, decimals: number, symbol: string): string {
  const one = 10n ** BigInt(decimals);
  const frac = (raw % one).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / one}${frac ? `.${frac}` : ''} ${symbol}`;
}
const sol = (lamports: bigint) => units(lamports, 9, 'SOL');

function le(data: Uint8Array, at: number, bytes: number): bigint {
  let v = 0n;
  for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[at + i] ?? 0);
  return v;
}

const startsWith = (data: Uint8Array, prefix: readonly number[]) =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

function sameKeys(a: readonly AccountMeta[], b: readonly AccountMeta[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (k, i) =>
        k.pubkey === b[i]?.pubkey &&
        k.isSigner === b[i]?.isSigner &&
        k.isWritable === b[i]?.isWritable,
    )
  );
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** An idempotent create of `owner`'s `mint` account, paid by `payer`. */
const ataCreateKeys = (
  payer: SolAddress,
  owner: SolAddress,
  mint: SolAddress,
  program: SolAddress,
): AccountMeta[] => [
  { pubkey: payer, isSigner: true, isWritable: true },
  {
    pubkey: associatedTokenAddress(owner, mint, program),
    isSigner: false,
    isWritable: true,
  },
  { pubkey: owner, isSigner: false, isWritable: false },
  { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  { pubkey: program, isSigner: false, isWritable: false },
];

/** The compute budget a transaction asks for: one limit and one price at most. */
interface Budget {
  limit: bigint | null;
  price: bigint | null;
}

function readBudget(ix: Instruction, b: Budget, actions: BlockedAction[]): void {
  const d = ix.data;
  if (ix.keys.length !== 0) actions.push(act('Compute budget', 'Unexpected accounts'));
  else if (d[0] === CU_SET_LIMIT && d.length === 5 && b.limit === null) {
    b.limit = le(d, 1, 4);
    actions.push(
      act(
        `Compute limit ${b.limit}`,
        b.limit > BigInt(MAX_COMPUTE_UNITS) ? 'Above the maximum' : undefined,
      ),
    );
  } else if (d[0] === CU_SET_PRICE && d.length === 9 && b.price === null) {
    b.price = le(d, 1, 8);
  } else actions.push(act('Compute budget', 'Unknown or repeated instruction'));
}

function checkPriority(b: Budget, maxLamports: bigint, actions: BlockedAction[]): void {
  if (b.price === null) return;
  const limit = b.limit ?? 200_000n;
  const fee = (b.price * limit + 999_999n) / 1_000_000n;
  actions.push(
    act(`Priority fee ${sol(fee)}`, fee > maxLamports ? 'Above your max network fee' : undefined),
  );
}

function checkSigners(
  instructions: readonly Instruction[],
  wallet: SolAddress,
  actions: BlockedAction[],
) {
  for (const k of instructions.flatMap((ix) => ix.keys)) {
    if (k.isSigner && k.pubkey !== wallet) {
      actions.push(act(`Signer ${short(k.pubkey)}`, 'Only your wallet may sign'));
    }
  }
}

/** An account a trade may open: the wallet's own (or a listed fee wallet's) for a mint. */
interface Opening {
  owner: SolAddress;
  mint: SolAddress;
  program: SolAddress;
  label: string;
}

/** The opening an associated-account instruction makes, if it is one of `opens`. */
function opening(ix: Instruction, wallet: SolAddress, opens: readonly Opening[]) {
  const d = ix.data;
  const owner = ix.keys[2]?.pubkey;
  const mint = ix.keys[3]?.pubkey;
  return d.length === 1 && d[0] === ATA_CREATE_IDEMPOTENT
    ? opens.find(
        (o) =>
          o.owner === owner &&
          o.mint === mint &&
          sameKeys(ix.keys, ataCreateKeys(wallet, o.owner, o.mint, o.program)),
      )
    : undefined;
}

/** What a system instruction wraps into the wallet's own WSOL account, or null. */
function wrapAmount(ix: Instruction, wallet: SolAddress): bigint | null {
  const d = ix.data;
  return d.length === 12 &&
    le(d, 0, 4) === BigInt(SYSTEM_TRANSFER) &&
    sameKeys(ix.keys, [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: wsolAccount(wallet), isSigner: false, isWritable: true },
    ])
    ? le(d, 4, 8)
    : null;
}

/** A token instruction on the wallet's own WSOL account: syncing it, or closing it to the wallet. */
function wsolStep(ix: Instruction, wallet: SolAddress): 'sync' | 'close' | null {
  const d = ix.data;
  const wsol = wsolAccount(wallet);
  if (d.length !== 1) return null;
  if (
    d[0] === TOKEN_SYNC_NATIVE &&
    sameKeys(ix.keys, [{ pubkey: wsol, isSigner: false, isWritable: true }])
  )
    return 'sync';
  if (
    d[0] === TOKEN_CLOSE_ACCOUNT &&
    sameKeys(ix.keys, [
      { pubkey: wsol, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
    ])
  )
    return 'close';
  return null;
}

const wsolAction = (step: 'sync' | 'close' | null) =>
  step === 'sync'
    ? act('Sync wrapped SOL')
    : step === 'close'
      ? act('Unwrap SOL')
      : act('Token program', 'Only your own wrapped SOL account');

export function validateSolanaTx(
  instructions: readonly Instruction[],
  ctx: SolValidationContext,
): SolValidationResult {
  const actions: BlockedAction[] = [];
  const { route, wallet } = ctx;
  const pay = route.pay;
  const solPay = isSolQuote(pay);
  const coin = routeCoin(route);
  const variant = routeVariant(route);
  const unit = ctx.payUnit ?? { symbol: 'SOL', decimals: 9 };
  const amount = (raw: bigint) => units(raw, unit.decimals, unit.symbol);
  const budget: Budget = { limit: null, price: null };
  let wrapped = 0n;
  let trades = 0;
  let spend = 0n;
  let amountIn = 0n;
  let minOut = 0n;

  if (coin.mint !== ctx.mint || !routeOk(route))
    actions.push(act('Route', 'Does not lead to this token'));

  checkSigners(instructions, wallet, actions);

  // The accounts a trade may open: the wallet's own in the coin and the pay currency, and
  // a listed buyback wallet's in the pay currency (the trade pays into it).
  const opens: Opening[] = [
    { owner: wallet, mint: coin.mint, program: coin.tokenProgram, label: 'Open token account' },
    {
      owner: wallet,
      mint: pay.mint,
      program: pay.program,
      label: solPay ? 'Open wrapped SOL account' : `Open ${unit.symbol} account`,
    },
    ...BUYBACK_FEE_RECIPIENTS.map((owner) => ({
      owner,
      mint: pay.mint,
      program: pay.program,
      label: `Open pump.fun's buyback ${unit.symbol} account`,
    })),
  ];

  for (const ix of instructions) {
    const d = ix.data;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM:
        readBudget(ix, budget, actions);
        break;
      case SYSTEM_PROGRAM: {
        const wrap = solPay && wrapped === 0n ? wrapAmount(ix, wallet) : null;
        if (wrap === null) {
          actions.push(act('System program', 'Only one transfer to your own wrapped SOL'));
          break;
        }
        wrapped = wrap;
        actions.push(act(`Wrap ${sol(wrapped)}`));
        break;
      }
      case ATA_PROGRAM: {
        const open = opening(ix, wallet, opens);
        actions.push(
          open ? act(open.label) : act('Token account', 'Not an account this trade needs'),
        );
        break;
      }
      case TOKEN_PROGRAM:
        // Only around SOL trades: wrapping into, and unwrapping, the wallet's own WSOL.
        actions.push(wsolAction(solPay ? wsolStep(ix, wallet) : null));
        break;
      case PUMP_PROGRAM:
      case PUMP_AMM_PROGRAM: {
        trades++;
        const label =
          variant === 'multi-hop' ? `a ${route.hops.length}-hop pump.fun route` : venueLabel(coin);
        if (ix.programId !== tradeProgram(variant)) {
          actions.push(act(`Trade on ${label}`, 'Not the trade this token takes'));
          break;
        }
        const rec = readRecipients(route, ix.keys);
        const keysOk =
          rec !== null &&
          (rec.fee === undefined || feeRecipients(coin).includes(rec.fee)) &&
          sameKeys(ix.keys, tradeAccounts(route, ctx.side, wallet, rec));
        if (!keysOk) {
          actions.push(act(`Trade on ${label}`, 'Accounts are not this token and wallet'));
          break;
        }
        const { disc, flag } = TRADE_DATA[variant][ctx.side];
        if (!startsWith(d, disc) || d.length !== (flag === undefined ? 24 : 25)) {
          actions.push(act(`Trade on ${label}`, 'Unknown instruction'));
          break;
        }
        amountIn = le(d, 8, 8);
        minOut = le(d, 16, 8);
        if (ctx.side === 'sell') {
          actions.push(act(`Sell on ${label}`, minOut === 0n ? 'No minimum received' : undefined));
          break;
        }
        spend = amountIn;
        actions.push(
          act(
            `Buy on ${label} for ${amount(spend)}`,
            flag !== undefined && d[24] !== flag
              ? flag === 0
                ? 'Partial fills are not allowed'
                : 'Volume tracking must stay on'
              : minOut === 0n
                ? 'No minimum received'
                : spend > ctx.maxSpend
                  ? 'Above your per-transaction limit'
                  : undefined,
          ),
        );
        break;
      }
      default:
        actions.push(act(`Program ${short(ix.programId)}`, 'Program is not on the allowlist'));
    }
  }

  if (trades !== 1) actions.push(act('Trade', 'Exactly one trade per transaction'));
  // SOL into a pool is wrapped first, exactly what the buy spends; nothing else wraps.
  const wraps = solPay && ctx.side === 'buy' && route.hops[0]?.kind === 'pool';
  if (wrapped !== (wraps ? spend : 0n)) {
    actions.push(act(`Wrap ${sol(wrapped)}`, 'Does not wrap what the trade spends'));
  }
  checkPriority(budget, ctx.maxPriorityLamports, actions);
  return { ok: actions.every((a) => a.ok), actions, spend, amountIn, minOut };
}

/** A new pump.fun coin from the website, with its dev buy (create/pump.ts builds both). */
export interface PumpCreateContext {
  wallet: SolAddress;
  /** The coin as the site asked for it: every instruction is built again from it. */
  coin: Omit<PumpCreate, 'user'> & { devBuy: bigint; minOut: bigint };
  /** The fresh curve the dev buy runs on, from pump.fun's Global as read now. */
  route: PumpRoute;
  /** Most the dev buy may spend, in lamports (from the USD limit). */
  maxSpend: bigint;
  maxPriorityLamports: bigint;
}

/**
 * Exactly the create_v2 Nesty builds for this coin and wallet and, with a dev buy, the
 * buy on its fresh curve: the only signers are the wallet and the coin's own new key, and
 * the buy pays fees only to wallets pump.fun lists.
 */
export function validatePumpCreate(
  instructions: readonly Instruction[],
  ctx: PumpCreateContext,
): SolValidationResult {
  const actions: BlockedAction[] = [];
  const { wallet, coin, route } = ctx;
  const budget: Budget = { limit: null, price: null };
  for (const k of instructions.flatMap((ix) => ix.keys)) {
    if (k.isSigner && k.pubkey !== wallet && k.pubkey !== coin.mint) {
      actions.push(act(`Signer ${short(k.pubkey)}`, 'Only your wallet and the new coin may sign'));
    }
  }
  const body: Instruction[] = [];
  for (const ix of instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) readBudget(ix, budget, actions);
    else body.push(ix);
  }
  // The buyback wallet the site picked for the buy, held to pump.fun's list.
  const trade =
    coin.devBuy > 0n ? body.slice(1).find((ix) => ix.programId === PUMP_PROGRAM) : undefined;
  const rec = trade ? readRecipients(route, trade.keys) : null;
  let expected: Instruction[] | null = null;
  if (coin.devBuy === 0n || rec) {
    try {
      expected = createInstructions({ ...coin, user: wallet }, route, rec);
    } catch {
      expected = null;
    }
  }
  const same =
    expected !== null &&
    expected.length === body.length &&
    expected.every((e, i) => {
      const ix = body[i];
      return (
        ix !== undefined &&
        ix.programId === e.programId &&
        sameKeys(ix.keys, e.keys) &&
        sameBytes(ix.data, e.data)
      );
    });
  actions.push(
    act(`Create ${coin.symbol} on pump.fun`, same ? undefined : 'Not the coin it says it is'),
  );
  if (coin.devBuy > 0n) {
    actions.push(
      act(
        `Buy it for ${sol(coin.devBuy)}`,
        coin.minOut === 0n
          ? 'No minimum received'
          : coin.devBuy > ctx.maxSpend
            ? 'Above your per-transaction limit'
            : undefined,
      ),
    );
  }
  checkPriority(budget, ctx.maxPriorityLamports, actions);
  return {
    ok: actions.every((a) => a.ok),
    actions,
    spend: coin.devBuy,
    amountIn: coin.devBuy,
    minOut: coin.minOut,
  };
}

/** A trade on another program's pool: as for pump.fun, with the pool in place of the route. */
export interface DexValidationContext extends Omit<SolValidationContext, 'route'> {
  /** The pool the trade was built on, as read from chain. */
  venue: DexVenue;
}

/**
 * Runs before every signature of a trade on a pool of another program. The swap must be
 * exactly the call Nesty builds for this pool and wallet from the amounts it names;
 * around it, only the wallet's own accounts in the coin and the pool's quote may be
 * opened, and SOL wrapped (exactly what a buy spends) and unwrapped.
 */
export function validateDexTx(
  instructions: readonly Instruction[],
  ctx: DexValidationContext,
): SolValidationResult {
  const actions: BlockedAction[] = [];
  const { venue: v, wallet } = ctx;
  const m = dexModule(v);
  const label = m.label(v);
  const solPay = isSolQuote(v.quote);
  const unit = ctx.payUnit ?? { symbol: 'SOL', decimals: 9 };
  const amount = (raw: bigint) => units(raw, unit.decimals, unit.symbol);
  const budget: Budget = { limit: null, price: null };
  let wrapped = 0n;
  let swaps = 0;
  let spend = 0n;
  let amountIn = 0n;
  let minOut = 0n;

  if (v.mint !== ctx.mint) actions.push(act('Pool', 'Does not trade this token'));
  checkSigners(instructions, wallet, actions);

  const opens: Opening[] = [
    { owner: wallet, mint: v.mint, program: v.tokenProgram, label: 'Open token account' },
    {
      owner: wallet,
      mint: v.quote.mint,
      program: v.quote.program,
      label: solPay ? 'Open wrapped SOL account' : `Open ${unit.symbol} account`,
    },
  ];

  for (const ix of instructions) {
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM:
        readBudget(ix, budget, actions);
        break;
      case SYSTEM_PROGRAM: {
        const wrap = solPay && wrapped === 0n ? wrapAmount(ix, wallet) : null;
        if (wrap === null) {
          actions.push(act('System program', 'Only one transfer to your own wrapped SOL'));
          break;
        }
        wrapped = wrap;
        actions.push(act(`Wrap ${sol(wrapped)}`));
        break;
      }
      case ATA_PROGRAM: {
        const open = opening(ix, wallet, opens);
        actions.push(
          open ? act(open.label) : act('Token account', 'Not an account this trade needs'),
        );
        break;
      }
      case TOKEN_PROGRAM:
        actions.push(wsolAction(solPay ? wsolStep(ix, wallet) : null));
        break;
      case m.program: {
        swaps++;
        const a = m.amounts(ix.data);
        if (!a) {
          actions.push(act(`Trade on ${label}`, 'Unknown instruction'));
          break;
        }
        // Rebuilt from the pool and the wallet: any other account or byte is refused.
        const want = m.swap(v, ctx.side, wallet, a.amountIn, a.minOut);
        if (!sameKeys(ix.keys, want.keys) || !sameBytes(ix.data, want.data)) {
          actions.push(act(`Trade on ${label}`, 'Accounts are not this pool and wallet'));
          break;
        }
        ({ amountIn, minOut } = a);
        if (ctx.side === 'sell') {
          actions.push(
            act(`Sell on ${label}`, a.minOut === 0n ? 'No minimum received' : undefined),
          );
          break;
        }
        spend = a.amountIn;
        actions.push(
          act(
            `Buy on ${label} for ${amount(spend)}`,
            a.minOut === 0n
              ? 'No minimum received'
              : spend > ctx.maxSpend
                ? 'Above your per-transaction limit'
                : undefined,
          ),
        );
        break;
      }
      default:
        actions.push(act(`Program ${short(ix.programId)}`, 'Program is not on the allowlist'));
    }
  }

  if (swaps !== 1) actions.push(act('Trade', 'Exactly one trade per transaction'));
  // Pools trade wrapped SOL: a buy wraps exactly what it spends; nothing else wraps.
  if (wrapped !== (solPay && ctx.side === 'buy' ? spend : 0n)) {
    actions.push(act(`Wrap ${sol(wrapped)}`, 'Does not wrap what the trade spends'));
  }
  checkPriority(budget, ctx.maxPriorityLamports, actions);
  return { ok: actions.every((a) => a.ok), actions, spend, amountIn, minOut };
}

/**
 * A transfer of SOL or one token to one address. Like trades, it runs before every
 * signature; the transaction may hold exactly that transfer, opening the recipient's token
 * account, and its compute budget. Nothing else.
 */
export interface SolTransferContext {
  wallet: SolAddress;
  /** The address receiving. For a token, its associated account is derived here. */
  to: SolAddress;
  /** The token sent, or null for SOL. */
  asset: { mint: SolAddress; program: SolAddress; decimals: number; symbol: string } | null;
  /** Exactly what is sent, in raw units. */
  amount: bigint;
  /** Most lamports the priority fee may cost (from the max network fee). */
  maxPriorityLamports: bigint;
}

export function validateSolanaTransfer(
  instructions: readonly Instruction[],
  ctx: SolTransferContext,
): { ok: boolean; actions: BlockedAction[] } {
  const actions: BlockedAction[] = [];
  const { wallet, to, asset, amount } = ctx;
  const budget: Budget = { limit: null, price: null };
  let moves = 0;
  checkSigners(instructions, wallet, actions);
  if (to === wallet) actions.push(act('Recipient', 'This is the wallet you are sending from'));
  const sent = asset ? units(amount, asset.decimals, asset.symbol) : sol(amount);

  for (const ix of instructions) {
    const d = ix.data;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM:
        readBudget(ix, budget, actions);
        break;
      case SYSTEM_PROGRAM: {
        moves++;
        const ok =
          asset === null &&
          d.length === 12 &&
          le(d, 0, 4) === BigInt(SYSTEM_TRANSFER) &&
          le(d, 4, 8) === amount &&
          sameKeys(ix.keys, [
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: to, isSigner: false, isWritable: true },
          ]);
        actions.push(
          ok
            ? act(`Send ${sent} to ${short(to)}`)
            : act('System program', 'Not the transfer you asked for'),
        );
        break;
      }
      case ATA_PROGRAM: {
        const ok =
          asset !== null &&
          d.length === 1 &&
          d[0] === ATA_CREATE_IDEMPOTENT &&
          sameKeys(ix.keys, ataCreateKeys(wallet, to, asset.mint, asset.program));
        actions.push(
          ok
            ? act(`Open the recipient's ${asset.symbol} account`)
            : act('Token account', "Not the recipient's account for this token"),
        );
        break;
      }
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM: {
        moves++;
        const ok =
          asset !== null &&
          ix.programId === asset.program &&
          d.length === 10 &&
          d[0] === TOKEN_TRANSFER_CHECKED &&
          le(d, 1, 8) === amount &&
          d[9] === asset.decimals &&
          sameKeys(ix.keys, [
            {
              pubkey: associatedTokenAddress(wallet, asset.mint, asset.program),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: asset.mint, isSigner: false, isWritable: false },
            {
              pubkey: associatedTokenAddress(to, asset.mint, asset.program),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: wallet, isSigner: true, isWritable: false },
          ]);
        actions.push(
          ok
            ? act(`Send ${sent} to ${short(to)}`)
            : act('Token program', 'Not the transfer you asked for'),
        );
        break;
      }
      default:
        actions.push(act(`Program ${short(ix.programId)}`, 'Program is not on the allowlist'));
    }
  }

  if (moves !== 1) actions.push(act('Transfer', 'Exactly one transfer per transaction'));
  checkPriority(budget, ctx.maxPriorityLamports, actions);
  return { ok: actions.every((a) => a.ok), actions };
}

/**
 * A bridge deposit into Relay's vault. Like trades and transfers, it runs before every
 * signature; the transaction may hold exactly the deposit Nesty builds from the wallet,
 * the amount and the id Relay quoted, and its compute budget. Nothing else.
 */
export interface RelayDepositContext {
  wallet: SolAddress;
  /** Exactly what is deposited, in lamports. */
  amount: bigint;
  /** The deposit id from Relay's quote: it ties the deposit to the request. */
  id: Uint8Array;
  /** Most the deposit may be (from the per-transaction USD limit). */
  maxSpend: bigint;
  /** Most lamports the priority fee may cost (from the max network fee). */
  maxPriorityLamports: bigint;
}

export function validateRelayDeposit(
  instructions: readonly Instruction[],
  ctx: RelayDepositContext,
): { ok: boolean; actions: BlockedAction[] } {
  const actions: BlockedAction[] = [];
  const budget: Budget = { limit: null, price: null };
  const want = relayDepositNative(ctx.wallet, ctx.amount, ctx.id);
  let deposits = 0;
  checkSigners(instructions, ctx.wallet, actions);

  for (const ix of instructions) {
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM:
        readBudget(ix, budget, actions);
        break;
      case RELAY_SOLANA_PROGRAM: {
        deposits++;
        const label = `Bridge deposit of ${sol(ctx.amount)}`;
        actions.push(
          ix.keys[2]?.pubkey !== ctx.wallet
            ? act(label, 'Deposit is not credited to the sending wallet')
            : !sameKeys(ix.keys, want.keys) || !sameBytes(ix.data, want.data)
              ? act(label, 'Not the deposit you asked for')
              : ctx.amount === 0n
                ? act(label, 'Empty deposit')
                : act(
                    label,
                    ctx.amount > ctx.maxSpend ? 'Above your per-transaction limit' : undefined,
                  ),
        );
        break;
      }
      default:
        actions.push(act(`Program ${short(ix.programId)}`, 'Program is not on the allowlist'));
    }
  }

  if (deposits !== 1) actions.push(act('Bridge deposit', 'Exactly one deposit per transaction'));
  checkPriority(budget, ctx.maxPriorityLamports, actions);
  return { ok: actions.every((a) => a.ok), actions };
}
