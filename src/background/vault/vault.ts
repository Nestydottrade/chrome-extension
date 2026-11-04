import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem';
import { HDKey, english as wordlist, privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { AddressSchema } from '../../shared/chains/schema';
import type { SolAddress } from '../../shared/solana';
import type { WalletAccount } from '../../shared/wallet';
import {
  exportSecretKey,
  parseSecretKey,
  publicKeyOf,
  slip10Derive,
  slip10Master,
  solanaPath,
  type Ed25519Node,
} from '../solana/keys';
import {
  KdfParamsSchema,
  calibrateKdf,
  deriveKeyBytes,
  importAesKey,
  open,
  seal,
  wipe,
  type KdfParams,
} from './crypto';
import { fromBase64, toBase64 } from '../../shared/base64';
import { passwordNeeds } from '../../shared/password';
import { MAX_ACCOUNTS } from './constants';

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every stored item (used once, to index caches written before they were bounded). */
  getAll?(): Promise<Record<string, unknown>>;
}

export type VaultErrorCode =
  | 'no_vault'
  | 'exists'
  | 'locked'
  | 'bad_password'
  | 'weak_password'
  | 'bad_mnemonic'
  | 'bad_private_key'
  | 'duplicate'
  | 'not_found'
  | 'primary'
  | 'limit'
  | 'too_many_attempts'
  | 'corrupt'
  | 'no_solana'
  | 'no_evm';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'VaultError';
  }
}

export { MAX_ACCOUNTS };
const HD_PATH = (i: number) => `m/44'/60'/0'/0/${i}`;

const VAULT_KEY = 'nesty.vault';
const SESSION_KEY = 'nesty.session';
const FAILS_KEY = 'nesty.unlockFails';

const SealedSchema = z.object({ iv: z.string(), ct: z.string() });
const VaultRecordSchema = z.object({
  version: z.literal(1),
  kdf: KdfParamsSchema,
  sealed: SealedSchema,
});
type VaultRecord = z.infer<typeof VaultRecordSchema>;

const HexKey = z.string().regex(/^0x[0-9a-f]{64}$/);
const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(32),
  /** EVM address: none for a wallet imported from a Solana key. */
  address: AddressSchema.optional(),
  hidden: z.boolean(),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('hd'), index: z.number().int().min(0) }),
    /** An EVM private key, in `keys`. */
    z.object({ type: z.literal('key'), keyId: z.string().min(1) }),
    /** A Solana key, in `solKeys`. */
    z.object({ type: z.literal('solkey'), keyId: z.string().min(1) }),
  ]),
});
type StoredAccount = z.infer<typeof AccountSchema>;

const PayloadSchema = z.object({
  v: z.literal(1),
  mnemonic: z.string(),
  nextIndex: z.number().int().min(0),
  keys: z.array(z.object({ id: z.string().min(1), privateKey: HexKey })),
  /** Imported Solana keys: each one's 32-byte ed25519 seed. Vaults from before have none. */
  solKeys: z.array(z.object({ id: z.string().min(1), seed: HexKey })).default([]),
  accounts: z.array(AccountSchema).min(1).max(MAX_ACCOUNTS),
  primaryId: z.string(),
});
type Payload = z.infer<typeof PayloadSchema>;

const SessionSchema = z.object({ key: z.string() });
const FailsSchema = z.object({ count: z.number().int(), until: z.number() });

function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(input: string): boolean {
  const m = normalizeMnemonic(input);
  const words = m.split(' ').length;
  return (words === 12 || words === 24) && validateMnemonic(m, wordlist);
}

/** Accepts 64 hex chars with or without 0x. Returns lowercase 0x-hex or null. */
export function normalizePrivateKey(input: string): Hex | null {
  const s = input.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  const hex = `0x${s}` as Hex;
  try {
    privateKeyToAddress(hex);
    return hex;
  } catch {
    return null;
  }
}

function aadFor(record: Pick<VaultRecord, 'version' | 'kdf'>): Uint8Array<ArrayBuffer> {
  // Binds the KDF parameters to the ciphertext so they cannot be downgraded.
  const k = record.kdf;
  return new TextEncoder().encode(
    `nesty-vault|v${record.version}|${k.alg}|${k.memoryKiB}|${k.iterations}|${k.parallelism}|${k.salt}`,
  );
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 32);
}

interface Unlocked {
  key: CryptoKey;
  record: VaultRecord;
  payload: Payload;
  hd: HDKey;
  /** Solana's tree (SLIP-0010 ed25519) from the same seed; its addresses are never stored. */
  sol: Ed25519Node;
  /** Solana addresses by `hd:<index>` or `key:<keyId>`, computed once per unlock. */
  solAddresses: Map<string, SolAddress>;
}

/** Both key trees from one seed: EVM (BIP-32) and Solana (SLIP-0010). */
function keyTrees(mnemonic: string): Pick<Unlocked, 'hd' | 'sol' | 'solAddresses'> {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const sol = slip10Master(seed);
  wipe(seed);
  return { hd, sol, solAddresses: new Map() };
}

export interface VaultDeps {
  local: KeyValueStore;
  session: KeyValueStore;
  /** Produces fresh KDF params for a new vault. Defaults to ~500 ms calibration. */
  kdf?: () => Promise<KdfParams>;
  now?: () => number;
}

/**
 * Encrypted wallet store. Only ciphertext + KDF params live in storage.local; the
 * derived AES key lives in storage.session while unlocked so the service worker can
 * restart without asking for the password again.
 */
export class Vault {
  private unlocked: Unlocked | null = null;
  private readonly kdf: () => Promise<KdfParams>;
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.kdf = deps.kdf ?? (() => calibrateKdf());
    this.now = deps.now ?? Date.now;
  }

  async exists(): Promise<boolean> {
    return (await this.loadRecord()) !== null;
  }

  async isUnlocked(): Promise<boolean> {
    return (await this.restore()) !== null;
  }

  async create(mnemonicInput: string, password: string): Promise<WalletAccount[]> {
    if (await this.exists()) throw new VaultError('exists');
    // Only a new wallet's password must meet the rule; unlock takes whatever decrypts it.
    if (passwordNeeds(password).length > 0) throw new VaultError('weak_password');
    if (!isValidMnemonic(mnemonicInput)) throw new VaultError('bad_mnemonic');
    const mnemonic = normalizeMnemonic(mnemonicInput);

    const trees = keyTrees(mnemonic);
    const first = this.deriveAccount(trees.hd, 0, 'Wallet 1');
    const payload: Payload = {
      v: 1,
      mnemonic,
      nextIndex: 1,
      keys: [],
      solKeys: [],
      accounts: [first],
      primaryId: first.id,
    };

    const kdf = await this.kdf();
    const raw = await deriveKeyBytes(password, kdf);
    const key = await importAesKey(raw);
    const record: VaultRecord = { version: 1, kdf, sealed: { iv: '', ct: '' } };
    record.sealed = await seal(key, encode(payload), aadFor(record));
    await this.deps.local.set(VAULT_KEY, record);
    await this.deps.session.set(SESSION_KEY, { key: toBase64(raw) });
    wipe(raw);
    this.unlocked = { key, record, payload, ...trees };
    return this.publicAccounts(this.unlocked);
  }

  async unlock(password: string): Promise<WalletAccount[]> {
    const record = await this.loadRecord();
    if (!record) throw new VaultError('no_vault');
    await this.checkThrottle();

    const raw = await deriveKeyBytes(password, record.kdf);
    const key = await importAesKey(raw);
    let payload: Payload;
    try {
      payload = await this.decrypt(key, record);
    } catch (err) {
      wipe(raw);
      if (err instanceof VaultError && err.code === 'corrupt') throw err;
      await this.recordFailure();
      throw new VaultError('bad_password');
    }
    await this.deps.session.remove(FAILS_KEY);
    await this.deps.session.set(SESSION_KEY, { key: toBase64(raw) });
    wipe(raw);
    const trees = keyTrees(payload.mnemonic);
    this.verifyAddresses(payload, trees.hd);
    this.unlocked = { key, record, payload, ...trees };
    return this.publicAccounts(this.unlocked);
  }

  async lock(): Promise<void> {
    this.unlocked = null;
    await this.deps.session.remove(SESSION_KEY);
  }

  /** Deletes the vault. Irreversible without the recovery phrase. */
  async reset(): Promise<void> {
    this.unlocked = null;
    await this.deps.session.remove(SESSION_KEY);
    await this.deps.session.remove(FAILS_KEY);
    await this.deps.local.remove(VAULT_KEY);
  }

  async listAccounts(): Promise<WalletAccount[]> {
    return this.publicAccounts(await this.require());
  }

  async addDerived(name?: string): Promise<WalletAccount> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    if (p.accounts.length >= MAX_ACCOUNTS) throw new VaultError('limit');
    const account = this.deriveAccount(
      u.hd,
      p.nextIndex,
      name ?? `Wallet ${p.accounts.length + 1}`,
    );
    p.nextIndex += 1;
    p.accounts.push(account);
    await this.persist(u, p);
    return this.toPublic(account, u);
  }

  /**
   * An EVM private key (64 hex characters) or a Solana secret key (base58, or a CLI keypair
   * file's JSON array). Each makes a wallet on its own chain family only.
   */
  async importPrivateKey(input: string, name?: string): Promise<WalletAccount> {
    const u = await this.require();
    const privateKey = normalizePrivateKey(input);
    if (!privateKey) return this.importSolanaKey(u, input, name);
    const p = structuredClone(u.payload);
    if (p.accounts.length >= MAX_ACCOUNTS) throw new VaultError('limit');
    const address = privateKeyToAddress(privateKey);
    if (p.accounts.some((a) => a.address === address)) throw new VaultError('duplicate');

    const keyId = crypto.randomUUID();
    p.keys.push({ id: keyId, privateKey });
    const account: StoredAccount = {
      id: crypto.randomUUID(),
      name: cleanName(name ?? '') || `Imported ${p.keys.length + p.solKeys.length}`,
      address,
      hidden: false,
      source: { type: 'key', keyId },
    };
    p.accounts.push(account);
    await this.persist(u, p);
    return this.toPublic(account, u);
  }

  async rename(id: string, name: string): Promise<void> {
    const n = cleanName(name);
    if (!n) throw new VaultError('not_found');
    await this.mutateAccount(id, (a) => {
      a.name = n;
    });
  }

  async setHidden(id: string, hidden: boolean): Promise<void> {
    const u = await this.require();
    if (hidden && u.payload.primaryId === id) throw new VaultError('primary');
    await this.mutateAccount(id, (a) => {
      a.hidden = hidden;
    });
  }

  async setPrimary(id: string): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    account.hidden = false;
    p.primaryId = id;
    await this.persist(u, p);
  }

  async remove(id: string): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (p.primaryId === id) throw new VaultError('primary');
    p.accounts = p.accounts.filter((a) => a.id !== id);
    if (account.source.type === 'key') {
      const keyId = account.source.keyId;
      p.keys = p.keys.filter((k) => k.id !== keyId);
    } else if (account.source.type === 'solkey') {
      const keyId = account.source.keyId;
      p.solKeys = p.solKeys.filter((k) => k.id !== keyId);
    }
    await this.persist(u, p);
  }

  /** Requires the password again, even while unlocked. Only reachable from the popup. */
  async exportPrivateKey(id: string, password: string): Promise<Hex> {
    await this.verifyPassword(password);
    return this.privateKeyFor(id);
  }

  /** Re-checks the password while unlocked (throttled like unlock). */
  async verifyPassword(password: string): Promise<void> {
    const u = await this.require();
    await this.checkThrottle();
    const raw = await deriveKeyBytes(password, u.record.kdf);
    try {
      await this.decrypt(await importAesKey(raw), u.record);
    } catch {
      await this.recordFailure();
      throw new VaultError('bad_password');
    } finally {
      wipe(raw);
    }
    await this.deps.session.remove(FAILS_KEY);
  }

  /**
   * Seals the wallet under a new password, with a fresh salt and newly calibrated Argon2id
   * parameters. Needs the current password even while unlocked, and the new one must meet
   * the rule for a new wallet. Nesty stays unlocked.
   */
  async changePassword(current: string, next: string): Promise<void> {
    const u = await this.require();
    if (passwordNeeds(next).length > 0) throw new VaultError('weak_password');
    await this.verifyPassword(current);
    const kdf = await this.kdf();
    const raw = await deriveKeyBytes(next, kdf);
    try {
      const key = await importAesKey(raw);
      const record: VaultRecord = { ...u.record, kdf };
      record.sealed = await seal(key, encode(u.payload), aadFor(record));
      await this.deps.local.set(VAULT_KEY, record);
      // From here the stored wallet opens only with the new key, so keep using that one.
      u.key = key;
      u.record = record;
      await this.deps.session.set(SESSION_KEY, { key: toBase64(raw) });
    } finally {
      wipe(raw);
    }
  }

  /** Background-internal: used by the signer. Never sent over messaging. */
  async privateKeyFor(id: string): Promise<Hex> {
    const u = await this.require();
    const account = u.payload.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (account.source.type === 'solkey') throw new VaultError('no_evm');
    if (account.source.type === 'key') {
      const keyId = account.source.keyId;
      const entry = u.payload.keys.find((k) => k.id === keyId);
      if (!entry) throw new VaultError('corrupt');
      return entry.privateKey as Hex;
    }
    const child = u.hd.derive(HD_PATH(account.source.index));
    if (!child.privateKey) throw new VaultError('corrupt');
    return bytesToHex(child.privateKey);
  }

  async addressOf(id: string): Promise<Address> {
    const u = await this.require();
    const account = u.payload.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (!account.address) throw new VaultError('no_evm');
    return account.address;
  }

  /**
   * Background-internal: account `id`'s Solana key (32-byte ed25519 seed), for the signer.
   * A wallet imported from an EVM key has none. The caller wipes it after use.
   */
  async solanaKeyFor(id: string): Promise<Uint8Array> {
    const u = await this.require();
    const account = u.payload.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (account.source.type === 'key') throw new VaultError('no_solana');
    if (account.source.type === 'solkey')
      return hexToBytes(this.solKey(u.payload, account.source.keyId));
    const node = slip10Derive(u.sol, solanaPath(account.source.index));
    wipe(node.chainCode);
    return node.key;
  }

  /** Like exportPrivateKey, in the format Phantom and Solflare import. */
  async exportSolanaKey(id: string, password: string): Promise<string> {
    await this.verifyPassword(password);
    const secret = await this.solanaKeyFor(id);
    try {
      return exportSecretKey(secret);
    } finally {
      wipe(secret);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async importSolanaKey(u: Unlocked, input: string, name?: string): Promise<WalletAccount> {
    const seed = parseSecretKey(input);
    if (!seed) throw new VaultError('bad_private_key');
    const address = publicKeyOf(seed);
    const hex = bytesToHex(seed);
    wipe(seed);
    const p = structuredClone(u.payload);
    if (p.accounts.length >= MAX_ACCOUNTS) throw new VaultError('limit');
    // Also a wallet of the recovery phrase: Phantom and Solflare export those keys too.
    if (this.publicAccounts(u).some((a) => a.solana === address)) throw new VaultError('duplicate');

    const keyId = crypto.randomUUID();
    p.solKeys.push({ id: keyId, seed: hex });
    const account: StoredAccount = {
      id: crypto.randomUUID(),
      name: cleanName(name ?? '') || `Imported ${p.keys.length + p.solKeys.length}`,
      hidden: false,
      source: { type: 'solkey', keyId },
    };
    p.accounts.push(account);
    await this.persist(u, p);
    return this.toPublic(account, u);
  }

  private solKey(payload: Payload, keyId: string): Hex {
    const entry = payload.solKeys.find((k) => k.id === keyId);
    if (!entry) throw new VaultError('corrupt');
    return entry.seed as Hex;
  }

  private async require(): Promise<Unlocked> {
    const u = await this.restore();
    if (!u) throw new VaultError((await this.exists()) ? 'locked' : 'no_vault');
    return u;
  }

  /** Rehydrates after a service-worker restart using the session key. */
  private async restore(): Promise<Unlocked | null> {
    if (this.unlocked) return this.unlocked;
    const session = SessionSchema.safeParse(await this.deps.session.get(SESSION_KEY));
    if (!session.success) return null;
    const record = await this.loadRecord();
    if (!record) return null;
    try {
      const raw = fromBase64(session.data.key);
      const key = await importAesKey(raw);
      wipe(raw);
      const payload = await this.decrypt(key, record);
      this.unlocked = { key, record, payload, ...keyTrees(payload.mnemonic) };
      return this.unlocked;
    } catch {
      await this.deps.session.remove(SESSION_KEY);
      return null;
    }
  }

  private async loadRecord(): Promise<VaultRecord | null> {
    const raw = await this.deps.local.get(VAULT_KEY);
    if (raw === undefined || raw === null) return null;
    const parsed = VaultRecordSchema.safeParse(raw);
    if (!parsed.success) throw new VaultError('corrupt');
    return parsed.data;
  }

  private async decrypt(key: CryptoKey, record: VaultRecord): Promise<Payload> {
    const pt = await open(key, record.sealed, aadFor(record));
    const parsed = PayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(pt)));
    wipe(pt);
    if (!parsed.success) throw new VaultError('corrupt');
    return parsed.data;
  }

  private async persist(u: Unlocked, payload: Payload): Promise<void> {
    PayloadSchema.parse(payload);
    const record: VaultRecord = {
      ...u.record,
      sealed: await seal(u.key, encode(payload), aadFor(u.record)),
    };
    await this.deps.local.set(VAULT_KEY, record);
    u.record = record;
    u.payload = payload;
  }

  private async mutateAccount(id: string, fn: (a: StoredAccount) => void): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    fn(account);
    await this.persist(u, p);
  }

  private deriveAccount(hd: HDKey, index: number, name: string): StoredAccount {
    const child = hd.derive(HD_PATH(index));
    if (!child.privateKey) throw new VaultError('corrupt');
    return {
      id: crypto.randomUUID(),
      name: cleanName(name) || `Wallet ${index + 1}`,
      address: privateKeyToAddress(bytesToHex(child.privateKey)),
      hidden: false,
      source: { type: 'hd', index },
    };
  }

  /** Guards against a tampered payload pointing an account name at a foreign address. */
  private verifyAddresses(payload: Payload, hd: HDKey): void {
    for (const a of payload.accounts) {
      let expected: Address;
      if (a.source.type === 'solkey') {
        // Its Solana address is computed from the key, never stored; it has no EVM one.
        this.solKey(payload, a.source.keyId);
        if (a.address !== undefined) throw new VaultError('corrupt');
        continue;
      }
      if (a.source.type === 'hd') {
        const child = hd.derive(HD_PATH(a.source.index));
        if (!child.privateKey) throw new VaultError('corrupt');
        expected = privateKeyToAddress(bytesToHex(child.privateKey));
      } else {
        const keyId = a.source.keyId;
        const entry = payload.keys.find((k) => k.id === keyId);
        if (!entry) throw new VaultError('corrupt');
        expected = privateKeyToAddress(entry.privateKey as Hex);
      }
      if (expected !== a.address) throw new VaultError('corrupt');
    }
  }

  private publicAccounts(u: Unlocked): WalletAccount[] {
    return u.payload.accounts.map((a) => this.toPublic(a, u));
  }

  private toPublic(a: StoredAccount, u: Unlocked): WalletAccount {
    const src = a.source;
    return {
      id: a.id,
      name: a.name,
      ...(a.address ? { address: a.address } : {}),
      hidden: a.hidden,
      primary: a.id === u.payload.primaryId,
      kind: src.type === 'hd' ? 'derived' : 'imported',
      ...(src.type === 'hd' ? { index: src.index, solana: this.solanaAddress(u, src.index) } : {}),
      ...(src.type === 'solkey' ? { solana: this.importedSolanaAddress(u, src.keyId) } : {}),
    };
  }

  /** Derived on demand and kept in memory only, so a tampered vault cannot swap it. */
  private solanaAddress(u: Unlocked, index: number): SolAddress {
    let address = u.solAddresses.get(`hd:${index}`);
    if (!address) {
      const node = slip10Derive(u.sol, solanaPath(index));
      address = publicKeyOf(node.key);
      wipe(node.key);
      wipe(node.chainCode);
      u.solAddresses.set(`hd:${index}`, address);
    }
    return address;
  }

  /** Like `solanaAddress`: computed from the imported key, never stored. */
  private importedSolanaAddress(u: Unlocked, keyId: string): SolAddress {
    let address = u.solAddresses.get(`key:${keyId}`);
    if (!address) {
      const seed = hexToBytes(this.solKey(u.payload, keyId));
      address = publicKeyOf(seed);
      wipe(seed);
      u.solAddresses.set(`key:${keyId}`, address);
    }
    return address;
  }

  private async checkThrottle(): Promise<void> {
    const fails = FailsSchema.safeParse(await this.deps.session.get(FAILS_KEY));
    if (fails.success && fails.data.until > this.now()) {
      throw new VaultError('too_many_attempts', fails.data.until - this.now());
    }
  }

  private async recordFailure(): Promise<void> {
    const prev = FailsSchema.safeParse(await this.deps.session.get(FAILS_KEY));
    const count = (prev.success ? prev.data.count : 0) + 1;
    // Free attempts first; then 30 s, 60 s, 120 s … capped at 15 min.
    const delay = count < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (count - 5));
    await this.deps.session.set(FAILS_KEY, { count, until: this.now() + delay });
  }
}

function encode(payload: Payload): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(payload));
}
