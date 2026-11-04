import { describe, expect, it, vi } from 'vitest';
import { publicKeyOf } from '../src/background/solana/keys';
import { bridgeDestination, outsidePassword } from '../src/background/trade/bridge-to';
import { TradeError } from '../src/background/trade/engine/core';
import { VaultError } from '../src/background/vault/vault';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';
import type { WalletAccount } from '../src/shared/wallet';

// Made up for the tests: never a real wallet's.
const SOL_ME = publicKeyOf(new Uint8Array(32).fill(1));
const SOL_STRANGER = publicKeyOf(new Uint8Array(32).fill(9));
const EVM_ME = '0x52908400098527886E0F7030069857D2E4169EE7';
const EVM_STRANGER = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
const PASSWORD = 'Correct horse battery 9!';

const accounts: WalletAccount[] = [
  {
    id: 'main',
    name: 'Main',
    hidden: false,
    primary: true,
    kind: 'derived',
    solana: SOL_ME,
    address: EVM_ME,
  },
  { id: 'sol', name: 'Sol only', hidden: false, primary: false, kind: 'derived', solana: SOL_ME },
];

describe('Where a bridge pays out', () => {
  it("pays one of the user's wallets at its address on the destination chain", () => {
    expect(bridgeDestination({ toChainId: 8453, toWalletId: 'main' }, accounts)).toEqual({
      recipient: EVM_ME,
      name: 'Main',
      outside: false,
    });
    expect(bridgeDestination({ toChainId: SOLANA_CHAIN_ID, toWalletId: 'main' }, accounts)).toEqual(
      { recipient: SOL_ME, name: 'Main', outside: false },
    );
  });

  it('refuses a wallet unknown, or without an address there', () => {
    expect(() => bridgeDestination({ toChainId: 8453, toWalletId: 'gone' }, accounts)).toThrow(
      new TradeError('not_found', 'Wallet not found.'),
    );
    expect(() => bridgeDestination({ toChainId: 8453, toWalletId: 'sol' }, accounts)).toThrow(
      new TradeError('not_found', 'Sol only has no EVM address.'),
    );
  });

  it('takes a wallet or an address, exactly one', () => {
    const neither = { toChainId: 8453 };
    const both = { toChainId: 8453, toWalletId: 'main', toAddress: EVM_STRANGER };
    for (const req of [neither, both])
      expect(() => bridgeDestination(req, accounts)).toThrow(
        new TradeError('blocked', 'Pick a wallet or an address to receive.'),
      );
  });

  it('pays an address typed as an outside one, shortened for the ticket', () => {
    expect(
      bridgeDestination({ toChainId: 8453, toAddress: EVM_STRANGER.toLowerCase() }, accounts),
    ).toEqual({ recipient: EVM_STRANGER, name: '0x8617…070D', outside: true });
    expect(
      bridgeDestination({ toChainId: SOLANA_CHAIN_ID, toAddress: ` ${SOL_STRANGER} ` }, accounts),
    ).toEqual({ recipient: SOL_STRANGER, name: expect.stringContaining('…'), outside: true });
  });

  it("knows an address typed that is one of the user's wallets", () => {
    expect(bridgeDestination({ toChainId: 1, toAddress: EVM_ME.toLowerCase() }, accounts)).toEqual({
      recipient: EVM_ME,
      name: 'Main',
      outside: false,
    });
    expect(bridgeDestination({ toChainId: SOLANA_CHAIN_ID, toAddress: SOL_ME }, accounts)).toEqual({
      recipient: SOL_ME,
      name: 'Main',
      outside: false,
    });
  });

  it('refuses an address of the other family, or one whose checksum is wrong', () => {
    // One letter's case changed: mixed case, so the checksum counts, and it is wrong.
    const wrongCase = EVM_STRANGER.replace('E340', 'e340');
    expect(() => bridgeDestination({ toChainId: 8453, toAddress: wrongCase }, accounts)).toThrow(
      new TradeError('blocked', 'Not a valid EVM address.'),
    );
    expect(() => bridgeDestination({ toChainId: 8453, toAddress: SOL_STRANGER }, accounts)).toThrow(
      new TradeError('blocked', 'Not a valid EVM address.'),
    );
    expect(() =>
      bridgeDestination({ toChainId: SOLANA_CHAIN_ID, toAddress: EVM_STRANGER }, accounts),
    ).toThrow(new TradeError('blocked', 'Not a valid Solana address.'));
  });
});

describe('The password for an outside address', () => {
  const vault = {
    verifyPassword: vi.fn(async (password: string) => {
      if (password !== PASSWORD) throw new VaultError('bad_password');
    }),
  };

  it('is not asked up to the confirmation amount, nor again once the window asked it', async () => {
    await outsidePassword(vault, {}, 20, 20);
    await outsidePassword(vault, { passwordChecked: true }, 500, 20);
    expect(vault.verifyPassword).not.toHaveBeenCalled();
  });

  it('is asked above it, and checked', async () => {
    await expect(outsidePassword(vault, {}, 20.01, 20)).rejects.toEqual(
      new TradeError('needs_password', '20.01'),
    );
    await expect(outsidePassword(vault, { password: 'wrong' }, 30, 20)).rejects.toEqual(
      new VaultError('bad_password'),
    );
    await expect(outsidePassword(vault, { password: PASSWORD }, 30, 20)).resolves.toBeUndefined();
  });
});
