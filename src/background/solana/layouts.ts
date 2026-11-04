import type { SolAddress } from '../../shared/solana';
import { toAddress } from './address';

/**
 * Little-endian reader over account data. Programs append fields over time and older
 * accounts stay shorter: past the end, fields read as zero / false / the default key.
 */
export class Reader {
  private o: number;

  constructor(
    private readonly b: Uint8Array,
    offset = 0,
  ) {
    this.o = offset;
  }

  get offset(): number {
    return this.o;
  }

  private take(n: number): Uint8Array | null {
    const at = this.o;
    this.o += n;
    return at + n <= this.b.length ? this.b.subarray(at, at + n) : null;
  }

  skip(n: number): this {
    this.o += n;
    return this;
  }

  u8(): number {
    return this.take(1)?.[0] ?? 0;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const s = this.take(2);
    return s ? (s[0] ?? 0) | ((s[1] ?? 0) << 8) : 0;
  }

  u32(): number {
    const s = this.take(4);
    return s ? new DataView(s.buffer, s.byteOffset, 4).getUint32(0, true) : 0;
  }

  u64(): bigint {
    const s = this.take(8);
    return s ? new DataView(s.buffer, s.byteOffset, 8).getBigUint64(0, true) : 0n;
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }

  i128(): bigint {
    const v = this.u128();
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }

  pubkey(): SolAddress {
    const s = this.take(32);
    return toAddress(s ?? new Uint8Array(32));
  }

  /** Borsh string: u32 length, then UTF-8. Fixed-size fields are padded with NULs. */
  string(max = 512): string {
    const len = this.u32();
    if (len > max) throw new Error('string too long');
    const s = this.take(len);
    return s ? new TextDecoder().decode(s).replace(/\0+$/g, '') : '';
  }
}

/** Anchor accounts start with an 8-byte discriminator. */
export function hasDiscriminator(data: Uint8Array, disc: readonly number[]): boolean {
  return data.length >= 8 && disc.every((b, i) => data[i] === b);
}

// ── SPL Token ───────────────────────────────────────────────────────────────

export interface MintInfo {
  supply: bigint;
  decimals: number;
  initialized: boolean;
  /** Token-2022 extension types present (empty for SPL Token mints). */
  extensions: number[];
  /** From the Token-2022 metadata extension, when the mint carries its own. */
  name?: string;
  symbol?: string;
  /** Where its metadata JSON is (with the image), as the extension names it. */
  uri?: string;
  /** Token-2022 transfer fee: basis points of every transfer, the newest one set. */
  transferFeeBps?: number;
  /** The program its transfer hook runs, when one is set (a hook without one runs nothing). */
  transferHookProgram?: SolAddress;
}

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165;
/** Token-2022 extension types. */
export const EXT = {
  transferFeeConfig: 1,
  mintCloseAuthority: 3,
  defaultAccountState: 6,
  nonTransferable: 9,
  interestBearing: 10,
  permanentDelegate: 12,
  transferHook: 14,
  metadataPointer: 18,
  tokenMetadata: 19,
  groupPointer: 20,
  tokenGroup: 21,
  groupMemberPointer: 22,
  tokenGroupMember: 23,
  scaledUiAmount: 25,
  pausable: 26,
} as const;

export function decodeMint(data: Uint8Array): MintInfo | null {
  if (data.length < MINT_SIZE) return null;
  const r = new Reader(data, 36);
  const supply = r.u64();
  const decimals = r.u8();
  const initialized = r.bool();
  const out: MintInfo = { supply, decimals, initialized, extensions: [] };
  // Token-2022: account type (1 = mint) at 165, then type-length-value extensions.
  if (data.length > ACCOUNT_SIZE && data[ACCOUNT_SIZE] === 1) {
    let o = ACCOUNT_SIZE + 1;
    while (o + 4 <= data.length) {
      const u16 = (at: number) => (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
      const type = u16(o);
      const len = u16(o + 2);
      if (type === 0 && len === 0) break;
      const value = data.subarray(o + 4, o + 4 + len);
      out.extensions.push(type);
      // Two authorities, the withheld amount, then the older and newer fee (epoch, maximum,
      // basis points): the newer one's basis points are the last two bytes.
      if (type === EXT.transferFeeConfig && len >= 108)
        out.transferFeeBps = (value[106] ?? 0) | ((value[107] ?? 0) << 8);
      // Its authority, then the program (all zeros for none).
      if (type === EXT.transferHook && len >= 64 && value.subarray(32, 64).some((b) => b !== 0))
        out.transferHookProgram = new Reader(value, 32).pubkey();
      if (type === EXT.tokenMetadata) {
        try {
          const m = new Reader(value, 64);
          out.name = m.string(256);
          out.symbol = m.string(64);
          out.uri = m.string(512);
        } catch {
          // Unreadable metadata: the name falls back to the Metaplex account or a default.
        }
      }
      o += 4 + len;
    }
  }
  return out;
}

export interface TokenAccountInfo {
  mint: SolAddress;
  owner: SolAddress;
  amount: bigint;
}

export function decodeTokenAccount(data: Uint8Array): TokenAccountInfo | null {
  if (data.length < ACCOUNT_SIZE) return null;
  const r = new Reader(data);
  return { mint: r.pubkey(), owner: r.pubkey(), amount: r.u64() };
}

/** The chain's clock, from the Clock sysvar: slot and Unix time. */
export interface ChainClock {
  slot: bigint;
  unixTime: bigint;
}

export function decodeClock(data: Uint8Array): ChainClock | null {
  if (data.length < 40) return null;
  return { slot: new Reader(data).u64(), unixTime: new Reader(data, 32).u64() };
}

/** Name, symbol and metadata URI from a Metaplex token metadata account. */
export function decodeMetaplexMetadata(
  data: Uint8Array,
): { name: string; symbol: string; uri: string } | null {
  try {
    const r = new Reader(data, 1 + 32 + 32);
    const name = r.string(64);
    const symbol = r.string(32);
    let uri = '';
    try {
      uri = r.string(256);
    } catch {
      // The name still counts without it.
    }
    return { name, symbol, uri };
  } catch {
    return null;
  }
}
