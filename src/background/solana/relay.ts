import type { SolAddress } from '../../shared/solana';
import { SYSTEM_PROGRAM, findProgramAddress, seed } from './address';
import { concat, meta, u64, type Instruction } from './tx';

/**
 * Relay's depository on Solana (relay.link, an Anchor program). A bridge from Solana is one
 * deposit_native into its vault, tagged with the id Relay quoted; a solver then pays the
 * recipient on the destination chain. The program and vault are the ones Relay lists for
 * Solana, and both PDAs below derive to the accounts its quotes name.
 */
export const RELAY_SOLANA_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
/** The program's state account. */
export const RELAY_SOLANA_STATE = findProgramAddress(
  [seed('relay_depository')],
  RELAY_SOLANA_PROGRAM,
);
/** Where deposits go. */
export const RELAY_SOLANA_VAULT = findProgramAddress([seed('vault')], RELAY_SOLANA_PROGRAM);
/** Anchor discriminator of deposit_native: sha256("global:deposit_native"), first 8 bytes. */
export const DEPOSIT_NATIVE = [0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06] as const;
/** Compute a deposit asks for before simulating (it used 13,551 on mainnet in October 2026). */
export const DEPOSIT_UNITS = 20_000;

/** deposit_native(amount, id): `amount` lamports from `wallet` into the vault, credited to it. */
export function relayDepositNative(
  wallet: SolAddress,
  amount: bigint,
  id: Uint8Array,
): Instruction {
  if (id.length !== 32) throw new Error('bad deposit id');
  return {
    programId: RELAY_SOLANA_PROGRAM,
    keys: [
      meta(RELAY_SOLANA_STATE),
      meta(wallet, true, true),
      // The depositor: whom Relay credits the deposit to.
      meta(wallet),
      meta(RELAY_SOLANA_VAULT, true),
      meta(SYSTEM_PROGRAM),
    ],
    data: concat(DEPOSIT_NATIVE, u64(amount), id),
  };
}
