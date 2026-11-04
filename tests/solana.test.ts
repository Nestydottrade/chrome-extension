import { mnemonicToSeedSync } from '@scure/bip39';
import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  TOKEN_PROGRAM,
  WSOL_MINT,
  addressBytes,
  findProgramAddress,
  isOnCurve,
  seed,
} from '../src/background/solana/address';
import { explainError } from '../src/background/solana/errors';
import {
  exportSecretKey,
  publicKeyOf,
  slip10Derive,
  slip10Master,
  solanaPath,
} from '../src/background/solana/keys';
import {
  AMM_FEE_CONFIG,
  AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEES_PROGRAM,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
} from '../src/background/solana/pump';
import { transfer } from '../src/background/solana/spl';
import {
  compactU16,
  compileMessage,
  serializeTransaction,
  type Instruction,
} from '../src/background/solana/tx';
import { isSolAddress } from '../src/shared/solana';

// Well-known test mnemonic (BIP-39 vectors). Never holds real funds.
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('SLIP-0010 ed25519', () => {
  // SLIP-0010 test vector 1 for ed25519.
  const seedBytes = hexToBytes('0x000102030405060708090a0b0c0d0e0f');

  it('derives the master node', () => {
    const m = slip10Master(seedBytes);
    expect(bytesToHex(m.key)).toBe(
      '0x2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    );
    expect(bytesToHex(m.chainCode)).toBe(
      '0x90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    );
  });

  it("derives m/0'", () => {
    const n = slip10Derive(slip10Master(seedBytes), [0]);
    expect(bytesToHex(n.key)).toBe(
      '0x68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    );
    expect(bytesToHex(n.chainCode)).toBe(
      '0x8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    );
  });

  it('only takes indexes below 2^31 (all are hardened)', () => {
    expect(() => slip10Derive(slip10Master(seedBytes), [2 ** 31])).toThrow();
    expect(() => slip10Derive(slip10Master(seedBytes), [-1])).toThrow();
  });

  it("gives Phantom's first address for a recovery phrase", () => {
    const m = slip10Master(mnemonicToSeedSync(ABANDON));
    const key = slip10Derive(m, solanaPath(0)).key;
    expect(publicKeyOf(key)).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });

  it('exports seed ‖ public key in base58', () => {
    const key = slip10Derive(slip10Master(mnemonicToSeedSync(ABANDON)), solanaPath(0)).key;
    const full = base58.decode(exportSecretKey(key));
    expect(full.length).toBe(64);
    expect(full.slice(0, 32)).toEqual(key);
    expect(base58.encode(full.slice(32))).toBe(publicKeyOf(key));
  });
});

describe('Solana addresses', () => {
  it('checks base58 addresses', () => {
    expect(isSolAddress(WSOL_MINT)).toBe(true);
    expect(isSolAddress(PUMP_PROGRAM)).toBe(true);
    expect(isSolAddress('0x' + '11'.repeat(20))).toBe(false);
    expect(isSolAddress('So1111111111111111111111111111111111111111O')).toBe(false);
    expect(isSolAddress('abc')).toBe(false);
  });

  it('derives the program addresses pump.fun documents', () => {
    expect(findProgramAddress([seed('global')], PUMP_PROGRAM)).toBe(PUMP_GLOBAL);
    expect(findProgramAddress([seed('fee_config'), PUMP_PROGRAM], PUMP_FEES_PROGRAM)).toBe(
      PUMP_FEE_CONFIG,
    );
    expect(findProgramAddress([seed('global_config')], PUMP_AMM_PROGRAM)).toBe(AMM_GLOBAL_CONFIG);
    expect(findProgramAddress([seed('fee_config'), PUMP_AMM_PROGRAM], PUMP_FEES_PROGRAM)).toBe(
      AMM_FEE_CONFIG,
    );
  });

  it('never returns an address on the curve', () => {
    const pda = findProgramAddress([seed('global')], PUMP_PROGRAM);
    expect(isOnCurve(addressBytes(pda))).toBe(false);
    // A wallet address is a public key, so it is on the curve.
    expect(isOnCurve(addressBytes('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'))).toBe(true);
  });
});

describe('transactions', () => {
  it('encodes compact-u16 lengths', () => {
    expect(compactU16(0)).toEqual([0]);
    expect(compactU16(127)).toEqual([0x7f]);
    expect(compactU16(128)).toEqual([0x80, 0x01]);
    expect(compactU16(16_384)).toEqual([0x80, 0x80, 0x01]);
  });

  it('orders the fee payer first and counts signers', () => {
    const payer = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
    const msg = compileMessage(
      payer,
      [transfer(payer, WSOL_MINT, 5n)],
      '11111111111111111111111111111111',
    );
    expect(msg.accounts[0]).toBe(payer);
    expect(msg.numSigners).toBe(1);
    // Header: 1 signer, 0 read-only signers, 1 read-only other (the system program).
    expect([...msg.bytes.slice(0, 3)]).toEqual([1, 0, 1]);
    expect(msg.accounts).toEqual([payer, WSOL_MINT, '11111111111111111111111111111111']);
    const raw = serializeTransaction(msg, []);
    expect(raw[0]).toBe(1);
    expect(raw.length).toBe(1 + 64 + msg.bytes.length);
  });

  it('refuses a token program mix-up in seeds', () => {
    expect(() => findProgramAddress([new Uint8Array(33)], TOKEN_PROGRAM)).toThrow();
  });
});

describe('trade errors', () => {
  const call = (programId: string): Instruction => ({
    programId,
    keys: [],
    data: new Uint8Array(),
  });
  const failed = (index: number, custom: number) => ({
    InstructionError: [index, { Custom: custom }],
  });

  it('explains pump.fun errors', () => {
    const ixs = [call(PUMP_PROGRAM)];
    expect(explainError(failed(0, 6042), ixs)).toMatch(/slippage/);
    expect(explainError(failed(0, 6005), ixs)).toMatch(/curve is complete/);
  });

  it('reads a code by the program that raised it', () => {
    // 6040 is missing rent on the curve, but slippage on PumpSwap.
    expect(explainError(failed(0, 6040), [call(PUMP_PROGRAM)])).toMatch(/new accounts/);
    expect(explainError(failed(1, 6040), [call(PUMP_PROGRAM), call(PUMP_AMM_PROGRAM)])).toMatch(
      /slippage/,
    );
    expect(explainError(failed(0, 1), [transfer(WSOL_MINT, PUMP_PROGRAM, 1n)])).toBe(
      'Insufficient SOL balance.',
    );
    expect(explainError(failed(0, 77), [call(PUMP_PROGRAM)])).toBe('Program error 77.');
  });

  it('explains runtime errors and never echoes anything else', () => {
    expect(explainError('BlockhashNotFound', [])).toMatch(/Expired/);
    expect(explainError({ InsufficientFundsForRent: { account_index: 2 } }, [])).toMatch(
      /keep the account open/,
    );
    expect(explainError({ InstructionError: [3, 'InvalidAccountData'] }, [])).toBe(
      'Failed: InvalidAccountData.',
    );
    expect(explainError('<img src=x> 9xQe…', [])).toBe('Transaction failed.');
    expect(explainError(null, [])).toBe('Transaction failed.');
  });
});
