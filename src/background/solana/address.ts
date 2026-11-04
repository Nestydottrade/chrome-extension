import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';
import type { SolAddress } from '../../shared/solana';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
/** Wrapped SOL: PumpSwap pools are quoted in it, and pump.fun's trades name it as the quote. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
/** Dollar stablecoins pump.fun coins are paired with: priced at $1. */
export const STABLE_MINTS: ReadonlySet<string> = new Set([
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  USD1_MINT,
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD (Token-2022)
]);
/** The coin of a pool's two mints: the one that is not wrapped SOL, else not a stablecoin. */
export function coinOfPair(a: SolAddress, b: SolAddress): SolAddress {
  if (a === WSOL_MINT) return b;
  if (b === WSOL_MINT) return a;
  return STABLE_MINTS.has(a) ? b : a;
}
/** The all-zero key: `Pubkey::default()` on chain. */
export const DEFAULT_KEY = SYSTEM_PROGRAM;

export function addressBytes(address: SolAddress): Uint8Array {
  const b = base58.decode(address);
  if (b.length !== 32) throw new Error('bad address');
  return b;
}

export function toAddress(bytes: Uint8Array): SolAddress {
  if (bytes.length !== 32) throw new Error('bad address');
  return base58.encode(bytes);
}

// The second (zip215) argument exists at runtime but not in the published types.
const decodePoint = ed25519.ExtendedPoint.fromHex.bind(ed25519.ExtendedPoint) as unknown as (
  hex: Uint8Array,
  zip215: boolean,
) => unknown;

/**
 * Whether 32 bytes decode to a point on ed25519. Lenient decoding (zip215), like the
 * runtime's: curve25519-dalek accepts non-canonical encodings.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    decodePoint(bytes, true);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const pdaCache = new Map<string, readonly [SolAddress, number]>();

/** Address seed bytes: a base58 address or raw bytes (at most 32). */
export type Seed = Uint8Array | string;

export function seed(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `Pubkey::find_program_address`: the first bump from 255 down that lands off the curve. */
export function findProgramAddress(seeds: readonly Seed[], program: SolAddress): SolAddress {
  return findProgramAddressWithBump(seeds, program)[0];
}

export function findProgramAddressWithBump(
  seeds: readonly Seed[],
  program: SolAddress,
): readonly [SolAddress, number] {
  const raw = seeds.map((s) => (typeof s === 'string' ? addressBytes(s) : s));
  const key = `${program}|${raw.map((b) => base58.encode(b)).join('|')}`;
  const hit = pdaCache.get(key);
  if (hit) return hit;
  if (raw.length > 15 || raw.some((s) => s.length > 32)) throw new Error('bad seeds');
  const programBytes = addressBytes(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256.create();
    for (const s of raw) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(programBytes);
    h.update(PDA_MARKER);
    const out = h.digest();
    if (!isOnCurve(out)) {
      const found = [toAddress(out), bump] as const;
      // Bounded: PDAs used by a few hundred trades at most.
      if (pdaCache.size > 2_000) pdaCache.clear();
      pdaCache.set(key, found);
      return found;
    }
  }
  throw new Error('no program address');
}

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAddress(
  owner: SolAddress,
  mint: SolAddress,
  tokenProgram: SolAddress = TOKEN_PROGRAM,
): SolAddress {
  return findProgramAddress([owner, tokenProgram, mint], ATA_PROGRAM);
}
