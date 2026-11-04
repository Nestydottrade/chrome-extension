import type { SolAddress } from '../../shared/solana';
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  associatedTokenAddress,
} from './address';
import { concat, meta, u32, u64, type Instruction } from './tx';

/** The most compute a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/** Instruction tags this module builds (and the validator accepts). */
export const SYSTEM_TRANSFER = 2;
export const TOKEN_CLOSE_ACCOUNT = 9;
export const TOKEN_SYNC_NATIVE = 17;
export const TOKEN_TRANSFER_CHECKED = 12;
export const ATA_CREATE_IDEMPOTENT = 1;
export const CU_SET_LIMIT = 2;
export const CU_SET_PRICE = 3;

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([CU_SET_LIMIT], u32(units)) };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    keys: [],
    data: concat([CU_SET_PRICE], u64(microLamports)),
  };
}

export function transfer(from: SolAddress, to: SolAddress, lamports: bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(from, true, true), meta(to, true)],
    data: concat(u32(SYSTEM_TRANSFER), u64(lamports)),
  };
}

/** Creates `owner`'s token account for `mint` unless it exists (paid by `payer`). */
export function createAtaIdempotent(
  owner: SolAddress,
  mint: SolAddress,
  tokenProgram: SolAddress,
  payer: SolAddress = owner,
): Instruction {
  return {
    programId: ATA_PROGRAM,
    keys: [
      meta(payer, true, true),
      meta(associatedTokenAddress(owner, mint, tokenProgram), true),
      meta(owner),
      meta(mint),
      meta(SYSTEM_PROGRAM),
      meta(tokenProgram),
    ],
    data: Uint8Array.of(ATA_CREATE_IDEMPOTENT),
  };
}

/**
 * Moves `amount` of `mint` from `owner`'s account to `to`'s, both the associated ones.
 * The checked form: the program verifies the mint and its decimals, and Token-2022 accepts
 * nothing else for mints with extensions.
 */
export function transferChecked(
  owner: SolAddress,
  to: SolAddress,
  mint: SolAddress,
  tokenProgram: SolAddress,
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programId: tokenProgram,
    keys: [
      meta(associatedTokenAddress(owner, mint, tokenProgram), true),
      meta(mint),
      meta(associatedTokenAddress(to, mint, tokenProgram), true),
      meta(owner, false, true),
    ],
    data: concat([TOKEN_TRANSFER_CHECKED], u64(amount), [decimals]),
  };
}

export function syncNative(account: SolAddress): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [meta(account, true)],
    data: Uint8Array.of(TOKEN_SYNC_NATIVE),
  };
}

/** Closes `owner`'s token account, sending its rent (and any wrapped SOL) back to `owner`. */
export function closeAccount(account: SolAddress, owner: SolAddress): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [meta(account, true), meta(owner, true), meta(owner, false, true)],
    data: Uint8Array.of(TOKEN_CLOSE_ACCOUNT),
  };
}

export function wsolAccount(owner: SolAddress): SolAddress {
  return associatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
}
