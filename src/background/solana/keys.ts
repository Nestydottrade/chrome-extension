import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';
import type { SolAddress } from '../../shared/solana';

/** A SLIP-0010 ed25519 node: the private key seed and its chain code. */
export interface Ed25519Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

const HARDENED = 0x8000_0000;

/**
 * Account `i`'s path, m/44'/501'/i'/0': what Phantom and Solflare use, so the same
 * recovery phrase shows the same Solana wallets there.
 */
export function solanaPath(index: number): number[] {
  return [44, 501, index, 0];
}

export function slip10Master(seed: Uint8Array): Ed25519Node {
  const i = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  return { key: i.slice(0, 32), chainCode: i.slice(32) };
}

/** ed25519 has hardened derivation only: every index is hardened. */
export function slip10Derive(node: Ed25519Node, path: readonly number[]): Ed25519Node {
  let { key, chainCode } = node;
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error('bad path');
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index + HARDENED, false);
    const i = hmac(sha512, chainCode, data);
    data.fill(0);
    key = i.slice(0, 32);
    chainCode = i.slice(32);
    i.fill(0);
  }
  return { key, chainCode };
}

export function publicKeyOf(secret: Uint8Array): SolAddress {
  return base58.encode(ed25519.getPublicKey(secret));
}

export function signMessage(message: Uint8Array, secret: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret);
}

/**
 * A Solana secret key as wallets export it: base58 of the 64-byte keypair (Phantom,
 * Solflare, Backpack) or the CLI's keypair file, a JSON array of those 64 bytes. Returns the
 * 32-byte seed, or null. The second half must be the seed's public key: that catches a
 * mistyped key, and a pasted address (32 bytes, and public) never becomes a key anyone could
 * recompute.
 */
export function parseSecretKey(input: string): Uint8Array | null {
  const s = input.trim();
  let full: Uint8Array;
  try {
    if (s.startsWith('[')) {
      const bytes: unknown = JSON.parse(s);
      if (
        !Array.isArray(bytes) ||
        !bytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)
      )
        return null;
      full = Uint8Array.from(bytes as number[]);
    } else {
      full = base58.decode(s);
    }
  } catch {
    return null;
  }
  if (full.length !== 64) {
    full.fill(0);
    return null;
  }
  const seed = full.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  const matches = pub.every((b, i) => b === full[32 + i]);
  full.fill(0);
  if (matches) return seed;
  seed.fill(0);
  return null;
}

/**
 * The 64-byte secret key (seed then public key) in base58: what Phantom and Solflare take
 * as "private key" on import.
 */
export function exportSecretKey(secret: Uint8Array): string {
  const full = new Uint8Array(64);
  full.set(secret, 0);
  full.set(ed25519.getPublicKey(secret), 32);
  const out = base58.encode(full);
  full.fill(0);
  return out;
}
