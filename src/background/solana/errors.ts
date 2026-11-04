import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from './address';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from './pump';
import type { Instruction } from './tx';

const SLIPPAGE = 'Price moved past your slippage. Raise slippage or try again.';

/** pump.fun program errors a trade can hit (docs: PUMP_PROGRAM_README, IDL). */
const PUMP_ERRORS: Record<number, string> = {
  6002: SLIPPAGE,
  6003: SLIPPAGE,
  6005: 'The pump.fun curve is complete. Trading opens on PumpSwap once it migrates.',
  6021: 'Not enough tokens left on the curve.',
  6023: 'Not enough tokens to sell.',
  6040: 'Not enough SOL to cover the new accounts.',
  6041: 'Not enough SOL to cover the fees.',
  6042: SLIPPAGE,
  // Nesty trades cashback coins with v2, mayhem pools with v1: these mean the coin changed.
  6094: 'pump.fun refused this trade for a cashback coin. Try again.',
};

const PUMP_AMM_ERRORS: Record<number, string> = {
  6004: SLIPPAGE,
  6040: SLIPPAGE,
  6063: 'The pool cannot pay out that much right now.',
  6078: 'This pool is not a pump.fun pool.',
  6079: 'PumpSwap refused this trade for a cashback coin. Try again.',
  6080: 'PumpSwap refused this trade for a mayhem pool. Try again.',
  6084: 'The route between the pools broke. Try again.',
  6085: 'A curve on the route moved mid-trade. Try again.',
  6086: 'The route mixed buys and sells.',
};

/**
 * A transaction error (from simulation or a landed transaction) as a sentence for the
 * ticket. Never echoes account data; unknown errors keep only their kind.
 */
export function explainError(err: unknown, instructions: readonly Instruction[]): string {
  if (typeof err === 'string') return topLevel(err);
  if (err && typeof err === 'object') {
    const [kind, value] = Object.entries(err as Record<string, unknown>)[0] ?? [];
    if (kind === 'InstructionError' && Array.isArray(value)) {
      const [index, inner] = value as [number, unknown];
      const program = instructions[index]?.programId;
      const custom =
        inner && typeof inner === 'object' && 'Custom' in inner
          ? Number((inner as { Custom: unknown }).Custom)
          : null;
      if (custom !== null) {
        if (program === PUMP_PROGRAM && PUMP_ERRORS[custom]) return PUMP_ERRORS[custom];
        if (program === PUMP_AMM_PROGRAM && PUMP_AMM_ERRORS[custom]) return PUMP_AMM_ERRORS[custom];
        // Custom 1 is the system or token program's "insufficient funds", also when a trade
        // runs into it moving tokens.
        if (custom === 1) {
          if (program === SYSTEM_PROGRAM) return 'Insufficient SOL balance.';
          if (program === TOKEN_PROGRAM || program === PUMP_PROGRAM || program === PUMP_AMM_PROGRAM)
            return 'Insufficient balance for this trade.';
        }
        return `Program error ${custom}.`;
      }
      if (typeof inner === 'string') return topLevel(inner);
    }
    if (kind === 'InsufficientFundsForRent') return 'Not enough SOL to keep the account open.';
    if (typeof kind === 'string') return topLevel(kind);
  }
  return 'Transaction failed.';
}

function topLevel(code: string): string {
  switch (code) {
    case 'InsufficientFundsForFee':
      return 'Not enough SOL for the network fee.';
    case 'BlockhashNotFound':
      return 'Expired before it landed. Try again.';
    case 'AccountNotFound':
      return 'This wallet has no SOL yet.';
    case 'InsufficientFunds':
      return 'Insufficient SOL balance.';
    case 'ComputationalBudgetExceeded':
    case 'ProgramFailedToComplete':
      return 'Ran out of compute. Try again.';
    default:
      // Our own names for the runtime's error kinds: letters only, never data.
      return /^[A-Za-z]{1,40}$/.test(code) ? `Failed: ${code}.` : 'Transaction failed.';
  }
}
