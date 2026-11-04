import { getAddress, parseTransaction, serializeSignature, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  WireCreateSpec,
  WireEvmTx,
  WirePermitPurpose,
  WirePermitSingle,
  WireTradeRef,
  WireTransferPermit,
  WireTxPurpose,
} from '../../shared/site-bridge';
import type { EvmAccount } from '../../shared/wallet';
import type { Vault } from '../vault/vault';
import { TRANSFER_PERMIT_TYPES, type TransferPermit } from './nesty-router';
import { PERMIT_TYPES, permitDomain } from './permit2';
import type { Side } from './types';
import type { PermitSingle } from './uniswap/codec';

/**
 * Who signs what the trade engine sends. In the extension that is the vault. On the Nesty
 * website it is the extension, asked over the site bridge: there each transaction carries
 * its purpose, how the engine built it, so the extension can build it again from its own
 * reading of the chain and sign only when both match (see site-evm.ts).
 */

/** The pool a trade is on, as the extension finds it again. */
export interface TradeRef {
  token: Address;
  venueId: string;
  poolId: string;
  /** On the pool's funding leg (native ↔ its asset), not on the pool itself. */
  leg?: boolean;
}

export type TxPurpose =
  /** A swap built by the venue's own builder. */
  | {
      kind: 'swap';
      ref: TradeRef;
      side: Side;
      amountIn: bigint;
      minOut: bigint;
      deadline: bigint;
      permit?: { permit: PermitSingle; signature: Hex } | undefined;
    }
  /** A funded pool's trade in one transaction through the Nesty Router. */
  | {
      kind: 'router';
      ref: TradeRef;
      side: Side;
      amountIn: bigint;
      assetMin: bigint;
      minOut: bigint;
      deadline: bigint;
      permit?: { permit: TransferPermit; signature: Hex } | undefined;
    }
  /** An ERC-20 approval a trade on the pool needs. */
  | { kind: 'approve'; ref: TradeRef; asset: Address; spender: Address; amount: bigint }
  /** A new coin on a launchpad, from the website's create form (see create/evm.ts). */
  | { kind: 'create'; spec: WireCreateSpec }
  /** A transaction already signed, again with higher fees (speed up). */
  | { kind: 'replace' }
  /** Nothing sent to the wallet itself: cancels a pending transaction or fills a nonce gap. */
  | { kind: 'empty' };

export type PermitPurpose =
  /** Permit2 allowance for the venue's router to take exactly one sell. */
  | { kind: 'permit'; ref: TradeRef; permit: PermitSingle }
  /** Permit2 one-time transfer to the Nesty Router. */
  | { kind: 'transfer'; ref: TradeRef; permit: TransferPermit; spender: Address };

export interface EvmTx {
  chainId: number;
  nonce: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type SignerWallet = Pick<EvmAccount, 'id' | 'address'>;

export interface EvmSigner {
  /** The signed transaction, serialized. Without a purpose only the vault signs. */
  transaction(wallet: SignerWallet, tx: EvmTx, purpose: TxPurpose | undefined): Promise<Hex>;
  /** A Permit2 signature on `chainId`. */
  permit(wallet: SignerWallet, chainId: number, purpose: PermitPurpose): Promise<Hex>;
}

/** Signs with the vault's keys, as the extension always has. */
export function vaultSigner(vault: Pick<Vault, 'privateKeyFor'>): EvmSigner {
  return {
    async transaction(wallet, tx) {
      return (await accountFor(vault, wallet)).signTransaction({ type: 'eip1559', ...tx });
    },
    async permit(wallet, chainId, purpose) {
      return signPermit(await accountFor(vault, wallet), chainId, purpose);
    },
  };
}

async function accountFor(vault: Pick<Vault, 'privateKeyFor'>, wallet: SignerWallet) {
  return privateKeyToAccount(await vault.privateKeyFor(wallet.id));
}

export function signPermit(
  account: ReturnType<typeof privateKeyToAccount>,
  chainId: number,
  purpose: PermitPurpose,
): Promise<Hex> {
  const domain = permitDomain(chainId);
  return purpose.kind === 'permit'
    ? account.signTypedData({
        domain,
        types: PERMIT_TYPES,
        primaryType: 'PermitSingle',
        message: purpose.permit,
      })
    : account.signTypedData({
        domain,
        types: TRANSFER_PERMIT_TYPES,
        primaryType: 'PermitTransferFrom',
        message: { ...purpose.permit, spender: purpose.spender },
      });
}

/** A signed transaction's signature alone (r, s, yParity), as the site bridge returns it. */
export function signatureOf(signed: Hex): Hex {
  const { r, s, yParity } = parseTransaction(signed);
  if (r === undefined || s === undefined || yParity === undefined)
    throw new Error('Unsigned transaction');
  return serializeSignature({ r, s, yParity });
}

// ── the site bridge's wire format: amounts as decimal strings ────────────────

export function txToWire(tx: EvmTx): WireEvmTx {
  return {
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value.toString(),
    gas: tx.gas.toString(),
    maxFeePerGas: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
  };
}

export function txFromWire(w: WireEvmTx): EvmTx {
  return {
    chainId: w.chainId,
    nonce: w.nonce,
    to: getAddress(w.to),
    data: w.data as Hex,
    value: BigInt(w.value),
    gas: BigInt(w.gas),
    maxFeePerGas: BigInt(w.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(w.maxPriorityFeePerGas),
  };
}

const refToWire = (r: TradeRef): WireTradeRef => ({
  token: r.token,
  venueId: r.venueId,
  poolId: r.poolId,
  ...(r.leg ? { leg: true } : {}),
});

const refFromWire = (w: WireTradeRef): TradeRef => ({
  token: getAddress(w.token),
  venueId: w.venueId,
  poolId: w.poolId,
  ...(w.leg ? { leg: true } : {}),
});

const permitToWire = (p: PermitSingle): WirePermitSingle => ({
  details: {
    token: p.details.token,
    amount: p.details.amount.toString(),
    expiration: p.details.expiration,
    nonce: p.details.nonce,
  },
  spender: p.spender,
  sigDeadline: p.sigDeadline.toString(),
});

const permitFromWire = (w: WirePermitSingle): PermitSingle => ({
  details: {
    token: getAddress(w.details.token),
    amount: BigInt(w.details.amount),
    expiration: w.details.expiration,
    nonce: w.details.nonce,
  },
  spender: getAddress(w.spender),
  sigDeadline: BigInt(w.sigDeadline),
});

const transferToWire = (p: TransferPermit): WireTransferPermit => ({
  permitted: { token: p.permitted.token, amount: p.permitted.amount.toString() },
  nonce: p.nonce.toString(),
  deadline: p.deadline.toString(),
});

const transferFromWire = (w: WireTransferPermit): TransferPermit => ({
  permitted: { token: getAddress(w.permitted.token), amount: BigInt(w.permitted.amount) },
  nonce: BigInt(w.nonce),
  deadline: BigInt(w.deadline),
});

export function purposeToWire(p: TxPurpose): WireTxPurpose {
  switch (p.kind) {
    case 'swap':
      return {
        kind: 'swap',
        ref: refToWire(p.ref),
        side: p.side,
        amountIn: p.amountIn.toString(),
        minOut: p.minOut.toString(),
        deadline: p.deadline.toString(),
        ...(p.permit
          ? { permit: { permit: permitToWire(p.permit.permit), signature: p.permit.signature } }
          : {}),
      };
    case 'router':
      return {
        kind: 'router',
        ref: refToWire(p.ref),
        side: p.side,
        amountIn: p.amountIn.toString(),
        assetMin: p.assetMin.toString(),
        minOut: p.minOut.toString(),
        deadline: p.deadline.toString(),
        ...(p.permit
          ? { permit: { permit: transferToWire(p.permit.permit), signature: p.permit.signature } }
          : {}),
      };
    case 'approve':
      return {
        kind: 'approve',
        ref: refToWire(p.ref),
        asset: p.asset,
        spender: p.spender,
        amount: p.amount.toString(),
      };
    case 'create':
      return { kind: 'create', spec: p.spec };
    default:
      return { kind: p.kind };
  }
}

export function purposeFromWire(w: WireTxPurpose): TxPurpose {
  switch (w.kind) {
    case 'swap':
      return {
        kind: 'swap',
        ref: refFromWire(w.ref),
        side: w.side,
        amountIn: BigInt(w.amountIn),
        minOut: BigInt(w.minOut),
        deadline: BigInt(w.deadline),
        ...(w.permit
          ? {
              permit: {
                permit: permitFromWire(w.permit.permit),
                signature: w.permit.signature as Hex,
              },
            }
          : {}),
      };
    case 'router':
      return {
        kind: 'router',
        ref: refFromWire(w.ref),
        side: w.side,
        amountIn: BigInt(w.amountIn),
        assetMin: BigInt(w.assetMin),
        minOut: BigInt(w.minOut),
        deadline: BigInt(w.deadline),
        ...(w.permit
          ? {
              permit: {
                permit: transferFromWire(w.permit.permit),
                signature: w.permit.signature as Hex,
              },
            }
          : {}),
      };
    case 'approve':
      return {
        kind: 'approve',
        ref: refFromWire(w.ref),
        asset: getAddress(w.asset),
        spender: getAddress(w.spender),
        amount: BigInt(w.amount),
      };
    case 'create':
      return { kind: 'create', spec: w.spec };
    default:
      return { kind: w.kind };
  }
}

export function permitPurposeToWire(p: PermitPurpose): WirePermitPurpose {
  return p.kind === 'permit'
    ? { kind: 'permit', ref: refToWire(p.ref), permit: permitToWire(p.permit) }
    : {
        kind: 'transfer',
        ref: refToWire(p.ref),
        permit: transferToWire(p.permit),
        spender: p.spender,
      };
}

export function permitPurposeFromWire(w: WirePermitPurpose): PermitPurpose {
  return w.kind === 'permit'
    ? { kind: 'permit', ref: refFromWire(w.ref), permit: permitFromWire(w.permit) }
    : {
        kind: 'transfer',
        ref: refFromWire(w.ref),
        permit: transferFromWire(w.permit),
        spender: getAddress(w.spender),
      };
}
