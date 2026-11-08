import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { bytesToHex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportSecretKey, parseSecretKey, publicKeyOf } from '../src/background/solana/keys';
import { deriveKeyBytes, importAesKey, seal, type KdfParams } from '../src/background/vault/crypto';
import { toBase64 } from '../src/shared/base64';
import {
  Vault,
  VaultError,
  isValidMnemonic,
  normalizePrivateKey,
  type KeyValueStore,
} from '../src/background/vault/vault';

// Well-known development mnemonic (Hardhat/Anvil). Never holds real funds.
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const DEV_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEV_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// Anvil account #2 private key, imported as a standalone key.
const DEV_PK_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const DEV_ADDR_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const PASSWORD = 'Correct horse battery 9!';
const NEW_PASSWORD = 'Another long one 7?';
// A made-up Solana key for these tests only: 32 bytes of 7. Never holds funds.
const SOL_SEED = new Uint8Array(32).fill(7);
const SOL_ADDR = publicKeyOf(SOL_SEED);
const SOL_KEYPAIR = exportSecretKey(SOL_SEED);
const SOL_CLI_FILE = JSON.stringify([...base58.decode(SOL_KEYPAIR)]);

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

// Tiny KDF so tests stay fast; production calibrates to ~500 ms.
const fastKdf = async (): Promise<KdfParams> => ({
  alg: 'argon2id',
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
  salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e) => e instanceof VaultError && e.code === code);
}

describe('Vault', () => {
  let local: MemoryStore;
  let session: MemoryStore;
  let clock: number;
  let vault: Vault;

  beforeEach(() => {
    local = new MemoryStore();
    session = new MemoryStore();
    clock = 1_000_000;
    vault = new Vault({ local, session, kdf: fastKdf, now: () => clock });
  });

  it("creates a vault deriving m/44'/60'/0'/0/0", async () => {
    const accounts = await vault.create(DEV_MNEMONIC, PASSWORD);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      address: DEV_ADDR_0,
      primary: true,
      kind: 'derived',
      index: 0,
    });
  });

  it('stores only ciphertext in local storage', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const dump = JSON.stringify([...local.data.values()]);
    expect(dump).not.toContain('test test');
    expect(dump.toLowerCase()).not.toContain(DEV_ADDR_0.slice(2).toLowerCase());
  });

  it('takes ten characters with no symbol', async () => {
    await vault.create(DEV_MNEMONIC, 'Tr0ub4dor3');
    await vault.lock();
    expect(await vault.unlock('Tr0ub4dor3')).toHaveLength(1);
  });

  it('rejects weak passwords, bad mnemonics and a second create', async () => {
    await expectCode(vault.create(DEV_MNEMONIC, 'short'), 'weak_password');
    await expectCode(vault.create(DEV_MNEMONIC, 'correct horse battery'), 'weak_password');
    await expectCode(vault.create('test '.repeat(12), PASSWORD), 'bad_mnemonic');
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await expectCode(vault.create(DEV_MNEMONIC, PASSWORD), 'exists');
  });

  it('checks the password rule only when creating', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    // Unlock and export only ask whether the password decrypts the wallet.
    await expectCode(vault.verifyPassword('short'), 'bad_password');
    await vault.lock();
    await expectCode(vault.unlock('short'), 'bad_password');
    expect(await vault.unlock(PASSWORD)).toHaveLength(1);
  });

  it('changes the password under a fresh salt and stays unlocked', async () => {
    const created = await vault.create(DEV_MNEMONIC, PASSWORD);
    const salt = () => (local.data.get('nesty.vault') as { kdf: { salt: string } }).kdf.salt;
    const before = salt();
    await vault.changePassword(PASSWORD, NEW_PASSWORD);
    expect(salt()).not.toBe(before);
    expect(await vault.listAccounts()).toEqual(created);
    // A restarted service worker opens the wallet with the new session key.
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect(await restarted.isUnlocked()).toBe(true);
    await vault.lock();
    await expectCode(vault.unlock(PASSWORD), 'bad_password');
    expect(await vault.unlock(NEW_PASSWORD)).toEqual(created);
  });

  it('keeps the password when the current one is wrong or the new one breaks the rule', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await expectCode(vault.changePassword('wrong password', NEW_PASSWORD), 'bad_password');
    await expectCode(vault.changePassword(PASSWORD, 'short'), 'weak_password');
    await expectCode(vault.changePassword(PASSWORD, 'correct horse battery'), 'weak_password');
    await vault.lock();
    await expectCode(vault.changePassword(PASSWORD, NEW_PASSWORD), 'locked');
    expect(await vault.unlock(PASSWORD)).toHaveLength(1);
  });

  it('locks and unlocks', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(false);
    await expectCode(vault.listAccounts(), 'locked');
    await expectCode(vault.unlock('wrong password'), 'bad_password');
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts[0]?.address).toBe(DEV_ADDR_0);
  });

  it('survives a service-worker restart via the session key', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect(await restarted.isUnlocked()).toBe(true);
    expect((await restarted.listAccounts())[0]?.address).toBe(DEV_ADDR_0);
  });

  it('is locked after the browser clears session storage', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    session.data.clear();
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect(await restarted.isUnlocked()).toBe(false);
  });

  it('throttles repeated wrong passwords', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    for (let i = 0; i < 5; i++) await expectCode(vault.unlock('nope nope'), 'bad_password');
    await expectCode(vault.unlock(PASSWORD), 'too_many_attempts');
    clock += 31_000;
    await expect(vault.unlock(PASSWORD)).resolves.toHaveLength(1);
  });

  it('derives further accounts and imports private keys', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const second = await vault.addDerived();
    expect(second).toMatchObject({ address: DEV_ADDR_1, index: 1, name: 'Wallet 2' });
    const imported = await vault.importPrivateKey(DEV_PK_2.slice(2), 'Sniper');
    expect(imported).toMatchObject({ address: DEV_ADDR_2, kind: 'imported', name: 'Sniper' });
    await expectCode(vault.importPrivateKey(DEV_PK_2), 'duplicate');
    await expectCode(vault.importPrivateKey('0x1234'), 'bad_private_key');
    await expectCode(vault.importPrivateKey('0x' + '0'.repeat(64)), 'bad_private_key');

    await vault.lock();
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts.map((a) => a.address)).toEqual([DEV_ADDR_0, DEV_ADDR_1, DEV_ADDR_2]);
  });

  it('renames, hides, sets primary and removes', async () => {
    const [first] = await vault.create(DEV_MNEMONIC, PASSWORD);
    const second = await vault.addDerived();
    await vault.rename(second.id, '  Main   bag ');
    await expectCode(vault.setHidden(first!.id, true), 'primary');
    await vault.setHidden(second.id, true);
    await vault.setPrimary(second.id);
    let accounts = await vault.listAccounts();
    expect(accounts.find((a) => a.id === second.id)).toMatchObject({
      name: 'Main bag',
      hidden: false,
      primary: true,
    });
    await expectCode(vault.remove(second.id), 'primary');
    await vault.remove(first!.id);
    accounts = await vault.listAccounts();
    expect(accounts.map((a) => a.id)).toEqual([second.id]);
  });

  it('exports a key only with the password', async () => {
    const [first] = await vault.create(DEV_MNEMONIC, PASSWORD);
    await expectCode(vault.exportPrivateKey(first!.id, 'wrong password'), 'bad_password');
    expect(await vault.exportPrivateKey(first!.id, PASSWORD)).toBe(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
  });

  it('detects ciphertext and parameter tampering', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    const record = (await local.get('nesty.vault')) as { kdf: KdfParams; sealed: { ct: string } };

    const flipped = structuredClone(record);
    const bytes = atob(flipped.sealed.ct);
    flipped.sealed.ct = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    await local.set('nesty.vault', flipped);
    await expectCode(vault.unlock(PASSWORD), 'bad_password');

    // Same key cannot be reused with downgraded params: AAD covers them.
    const downgraded = structuredClone(record);
    downgraded.kdf.memoryKiB = 32;
    await local.set('nesty.vault', downgraded);
    await expectCode(vault.unlock(PASSWORD), 'bad_password');
  });

  it('reset removes everything', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.reset();
    expect(await vault.exists()).toBe(false);
    expect(local.data.size + session.data.size).toBe(0);
  });
});

describe('Vault with imported Solana keys', () => {
  let local: MemoryStore;
  let session: MemoryStore;
  let vault: Vault;

  beforeEach(() => {
    local = new MemoryStore();
    session = new MemoryStore();
    vault = new Vault({ local, session, kdf: fastKdf });
  });

  /** Seals `payload` the way the vault does, as a vault written by any version would be. */
  async function writeVault(payload: unknown) {
    const kdf = await fastKdf();
    const key = await importAesKey(await deriveKeyBytes(PASSWORD, kdf));
    const aad = new TextEncoder().encode(
      `nesty-vault|v1|${kdf.alg}|${kdf.memoryKiB}|${kdf.iterations}|${kdf.parallelism}|${kdf.salt}`,
    );
    const sealed = await seal(key, new TextEncoder().encode(JSON.stringify(payload)), aad);
    await local.set('nesty.vault', { version: 1, kdf, sealed });
  }

  it('makes a Solana-only wallet from a Phantom key or a CLI keypair file', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const sol = await vault.importPrivateKey(
      `  ${SOL_KEYPAIR}
`,
      'Sol bag',
    );
    expect(sol).toMatchObject({ name: 'Sol bag', kind: 'imported', solana: SOL_ADDR });
    expect(sol.address).toBeUndefined();
    // The same key as a CLI file is the same wallet.
    await expectCode(vault.importPrivateKey(SOL_CLI_FILE), 'duplicate');
    await vault.remove(sol.id);
    const again = await vault.importPrivateKey(SOL_CLI_FILE);
    expect(again).toMatchObject({ name: 'Imported 1', solana: SOL_ADDR });

    expect(await vault.solanaKeyFor(again.id)).toEqual(SOL_SEED);
    expect(await vault.exportSolanaKey(again.id, PASSWORD)).toBe(SOL_KEYPAIR);
    await expectCode(vault.privateKeyFor(again.id), 'no_evm');
    await expectCode(vault.exportPrivateKey(again.id, PASSWORD), 'no_evm');
    await expectCode(vault.addressOf(again.id), 'no_evm');
  });

  it('keeps imported Solana keys across a lock and a service-worker restart', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const sol = await vault.importPrivateKey(SOL_KEYPAIR);
    expect(JSON.stringify([...local.data.values()])).not.toContain(SOL_ADDR);
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect((await restarted.listAccounts()).find((a) => a.id === sol.id)?.solana).toBe(SOL_ADDR);
    await vault.lock();
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts.map((a) => [a.address, a.solana])).toEqual([
      [DEV_ADDR_0, expect.any(String)],
      [undefined, SOL_ADDR],
    ]);
  });

  it('refuses keys that are not a full keypair', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    // An address is 32 public bytes: as a key, anyone could recompute it.
    await expectCode(vault.importPrivateKey(SOL_ADDR), 'bad_private_key');
    const full = base58.decode(SOL_KEYPAIR);
    full[40] = (full[40] ?? 0) ^ 1;
    await expectCode(vault.importPrivateKey(base58.encode(full)), 'bad_private_key');
    await expectCode(vault.importPrivateKey('[1,2,3]'), 'bad_private_key');
    await expectCode(vault.importPrivateKey('[' + '300,'.repeat(63) + '300]'), 'bad_private_key');
  });

  it("knows a recovery-phrase wallet's own Solana key", async () => {
    const [first] = await vault.create(DEV_MNEMONIC, PASSWORD);
    const exported = await vault.exportSolanaKey(first!.id, PASSWORD);
    await expectCode(vault.importPrivateKey(exported), 'duplicate');
  });

  it('opens a vault written before Solana keys could be imported', async () => {
    const created = await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.reset();
    await writeVault({
      v: 1,
      mnemonic: DEV_MNEMONIC,
      nextIndex: 1,
      keys: [],
      accounts: [
        {
          id: 'a',
          name: 'Wallet 1',
          address: DEV_ADDR_0,
          hidden: false,
          source: { type: 'hd', index: 0 },
        },
      ],
      primaryId: 'a',
    });
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts[0]).toMatchObject({ address: DEV_ADDR_0, solana: created[0]?.solana });
    await vault.importPrivateKey(SOL_KEYPAIR);
    expect(await vault.listAccounts()).toHaveLength(2);
  });

  it('refuses a stored Solana key wallet that claims an EVM address', async () => {
    await writeVault({
      v: 1,
      mnemonic: DEV_MNEMONIC,
      nextIndex: 1,
      keys: [],
      solKeys: [{ id: 'k', seed: bytesToHex(SOL_SEED) }],
      accounts: [
        {
          id: 'a',
          name: 'Wallet 1',
          address: DEV_ADDR_0,
          hidden: false,
          source: { type: 'hd', index: 0 },
        },
        {
          id: 'b',
          name: 'Sol',
          address: DEV_ADDR_1,
          hidden: false,
          source: { type: 'solkey', keyId: 'k' },
        },
      ],
      primaryId: 'a',
    });
    await expectCode(vault.unlock(PASSWORD), 'corrupt');
  });
});

describe('Solana secret keys', () => {
  it('reads base58 keypairs and CLI files, and nothing shorter', () => {
    expect(parseSecretKey(SOL_KEYPAIR)).toEqual(SOL_SEED);
    expect(parseSecretKey(` ${SOL_CLI_FILE} `)).toEqual(SOL_SEED);
    expect(parseSecretKey(SOL_ADDR)).toBeNull();
    expect(parseSecretKey(DEV_PK_2)).toBeNull();
    expect(parseSecretKey('not a key')).toBeNull();
    expect(parseSecretKey('{"secret": 1}')).toBeNull();
    // 64 bytes, but the second half is not the first half's public key.
    const mixed = new Uint8Array(64).fill(7);
    expect(parseSecretKey(base58.encode(mixed))).toBeNull();
    const right = new Uint8Array(64);
    right.set(SOL_SEED);
    right.set(ed25519.getPublicKey(SOL_SEED), 32);
    expect(parseSecretKey(base58.encode(right))).toEqual(SOL_SEED);
  });
});

describe('input helpers', () => {
  it('validates mnemonics loosely formatted', () => {
    expect(isValidMnemonic(`  ${DEV_MNEMONIC.toUpperCase().replace(/ /g, '   ')} `)).toBe(true);
    expect(isValidMnemonic('test test test')).toBe(false);
  });

  it('normalizes private keys', () => {
    expect(normalizePrivateKey(DEV_PK_2.toUpperCase().replace('0X', ''))).toBe(DEV_PK_2);
    expect(normalizePrivateKey('xyz')).toBeNull();
  });
});
