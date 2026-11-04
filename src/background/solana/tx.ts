import { base58 } from '@scure/base';
import type { SolAddress } from '../../shared/solana';
import { addressBytes } from './address';

export interface AccountMeta {
  pubkey: SolAddress;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: SolAddress;
  keys: AccountMeta[];
  data: Uint8Array;
}

/** The most a transaction may take on the wire (one IPv6 packet minus headers). */
export const MAX_TX_BYTES = 1232;

/** Legacy message, compiled: what is signed and what the account indexes point at. */
export interface CompiledMessage {
  bytes: Uint8Array;
  accounts: SolAddress[];
  numSigners: number;
}

export function compactU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('bad length');
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/**
 * Compiles a legacy message. Accounts are ordered as the runtime requires: writable
 * signers (the fee payer first), read-only signers, writable others, read-only others.
 */
export function compileMessage(
  payer: SolAddress,
  instructions: readonly Instruction[],
  recentBlockhash: string,
): CompiledMessage {
  const flags = new Map<SolAddress, { signer: boolean; writable: boolean }>();
  const note = (key: SolAddress, signer: boolean, writable: boolean) => {
    const f = flags.get(key);
    if (f) {
      f.signer ||= signer;
      f.writable ||= writable;
    } else flags.set(key, { signer, writable });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable);
    note(ix.programId, false, false);
  }
  const all = [...flags];
  const group = (signer: boolean, writable: boolean) =>
    all.filter(([, f]) => f.signer === signer && f.writable === writable).map(([k]) => k);
  const writableSigners = group(true, true).filter((k) => k !== payer);
  const accounts = [
    payer,
    ...writableSigners,
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ];
  const numSigners = 1 + writableSigners.length + group(true, false).length;
  const index = new Map(accounts.map((k, i) => [k, i]));
  if (accounts.length > 256) throw new Error('too many accounts');

  const out: number[] = [numSigners, group(true, false).length, group(false, false).length];
  out.push(...compactU16(accounts.length));
  for (const k of accounts) out.push(...addressBytes(k));
  const hash = base58.decode(recentBlockhash);
  if (hash.length !== 32) throw new Error('bad blockhash');
  out.push(...hash);
  out.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    out.push(index.get(ix.programId) as number);
    out.push(...compactU16(ix.keys.length));
    for (const k of ix.keys) out.push(index.get(k.pubkey) as number);
    out.push(...compactU16(ix.data.length));
    out.push(...ix.data);
  }
  return { bytes: Uint8Array.from(out), accounts, numSigners };
}

/** Wire format: the signatures (zeros where missing), then the message. */
export function serializeTransaction(
  message: CompiledMessage,
  signatures: readonly Uint8Array[],
): Uint8Array {
  const sigs = Array.from({ length: message.numSigners }, (_, i) => {
    const s = signatures[i];
    return s && s.length === 64 ? s : new Uint8Array(64);
  });
  const head = compactU16(message.numSigners);
  const out = new Uint8Array(head.length + 64 * sigs.length + message.bytes.length);
  out.set(head, 0);
  sigs.forEach((s, i) => out.set(s, head.length + 64 * i));
  out.set(message.bytes, head.length + 64 * sigs.length);
  if (out.length > MAX_TX_BYTES) throw new Error('transaction too large');
  return out;
}

/** Little-endian u64 for instruction data. */
export function u64(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new Error('u64 out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const meta = (pubkey: SolAddress, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});
