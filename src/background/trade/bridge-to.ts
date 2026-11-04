import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import { SolAddressSchema, isSolana } from '../../shared/solana';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import type { Vault } from '../vault/vault';
import { TradeError } from './engine/core';

/** Who a bridge pays on the destination chain. */
export interface BridgeDestination {
  recipient: string;
  /** The wallet's name, or the address shortened when it is none of the user's. */
  name: string;
  /** None of the user's wallets: paid like a Send. */
  outside: boolean;
}

/**
 * Where a bridge pays out: one of the user's wallets, picked by id, or an address typed for
 * it. A typed address must be one of the destination chain (base58 on Solana, 0x elsewhere),
 * and one of the user's own is that wallet.
 */
export function bridgeDestination(
  req: { toChainId: number; toWalletId?: string | undefined; toAddress?: string | undefined },
  accounts: readonly WalletAccount[],
): BridgeDestination {
  const toSolana = isSolana(req.toChainId);
  const family = toSolana ? 'Solana' : 'EVM';
  if ((req.toWalletId === undefined) === (req.toAddress === undefined))
    throw new TradeError('blocked', 'Pick a wallet or an address to receive.');
  if (req.toWalletId !== undefined) {
    const to = accounts.find((a) => a.id === req.toWalletId);
    if (!to) throw new TradeError('not_found', 'Wallet not found.');
    const recipient = toSolana ? to.solana : to.address;
    if (!recipient) throw new TradeError('not_found', `${to.name} has no ${family} address.`);
    return { recipient, name: to.name, outside: false };
  }
  const recipient = typedAddress(req.toAddress ?? '', toSolana);
  if (!recipient) throw new TradeError('blocked', `Not a valid ${family} address.`);
  const mine = accounts.find((a) =>
    toSolana
      ? a.solana === recipient
      : a.address !== undefined && isAddressEqual(a.address, recipient as Address),
  );
  return mine
    ? { recipient, name: mine.name, outside: false }
    : { recipient, name: shortAddress(recipient), outside: true };
}

/** A typed address as the chain writes it, or null when it is none of that chain family's. */
function typedAddress(typed: string, solana: boolean): string | null {
  const s = typed.trim();
  if (solana) return SolAddressSchema.safeParse(s).success ? s : null;
  // A mixed-case address must carry a valid checksum: a typo in it is caught here.
  return isAddress(s, { strict: true }) ? getAddress(s) : null;
}

/**
 * An outside address is paid like a Send: above the confirmation amount the password is
 * needed again, unless the website's approval window already asked for it.
 */
export async function outsidePassword(
  vault: Pick<Vault, 'verifyPassword'>,
  req: { password?: string | undefined; passwordChecked?: boolean | undefined },
  usd: number,
  confirmAboveUsd: number,
): Promise<void> {
  if (usd <= confirmAboveUsd || req.passwordChecked) return;
  if (!req.password) throw new TradeError('needs_password', usd.toFixed(2));
  await vault.verifyPassword(req.password);
}

export const tokenContractBlock = (symbol: string) =>
  new TradeError('blocked', `This is the ${symbol} token contract: funds sent there are lost.`);
