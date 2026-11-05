import type { AlertInput, AlertView } from './alerts';
import type { BlockedAction } from './panel';
import type { FollowEdit, FollowInput, TrackerView } from './tracker';
import type { SolAddress } from './solana';

/**
 * How the Nesty website talks to the extension: window messages, which the extension's
 * content script on that site (and nowhere else) carries to the background. The site
 * builds every trade itself, Solana and EVM; the extension keeps the keys, checks each
 * transaction again (route, limits, validator) and returns only a signature. Bridges are
 * the exception: the extension quotes, signs and sends them itself, so the address paid is
 * the one the user saw. These are the messages' shapes: the background parses every request
 * again (RequestSchema).
 */

/** Page → extension. */
export const SITE_SOURCE = 'nesty-site';
/** Extension → page. */
export const EXTENSION_SOURCE = 'nesty-extension';

/**
 * What the site may ask for: nothing that reads a key, and no funds moved but a trade, a new
 * coin or a bridge (to an outside address only once the user approves it in the extension).
 * It may also keep price alerts in the extension, which reads the prices and notifies, and
 * follow wallets there, whose trades the extension reads and notifies.
 */
export const SITE_METHODS = {
  hello: 'site.hello',
  connect: 'site.connect',
  disconnect: 'site.disconnect',
  wallets: 'site.wallets',
  unlock: 'site.unlock',
  signSolana: 'site.sol.sign',
  signEvm: 'site.evm.sign',
  signEvmPermit: 'site.evm.permit',
  bridgeQuote: 'site.bridge.quote',
  bridge: 'site.bridge.send',
  bridgeStatus: 'site.bridge.status',
  alerts: 'site.alerts.list',
  setAlert: 'site.alerts.set',
  removeAlert: 'site.alerts.remove',
  trackerFeed: 'site.tracker.feed',
  follow: 'site.tracker.follow',
  unfollow: 'site.tracker.unfollow',
  editFollow: 'site.tracker.edit',
  trackerPrefs: 'site.tracker.prefs',
} as const;
export type SiteMethod = keyof typeof SITE_METHODS;

export interface SitePageRequest {
  source: typeof SITE_SOURCE;
  id: string;
  method: SiteMethod;
  params?: unknown;
}

export type SitePageResponse = { source: typeof EXTENSION_SOURCE; id: string } & (
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail?: string; actions?: BlockedAction[] }
);

/** Unprompted: the extension is there (on load, and in answer to a hello), or the vault locked or unlocked. */
export type SitePageEvent = { source: typeof EXTENSION_SOURCE } & (
  { event: 'ready' } | { event: 'vault'; unlocked: boolean }
);

/** The user's limits, which every trade the site asks to sign is held to. */
export interface SiteLimits {
  maxUsdPerTx: number;
  maxUsdPerClick: number;
  confirmAboveUsd: number;
  maxGasUsd: number;
  /** EVM sell approvals: unlimited, or bounded to holdings plus this buffer. */
  unlimitedApprovals: boolean;
  approvalBufferBps: number;
}

export interface SiteHello {
  version: string;
  /** A wallet exists (set up in the extension). */
  exists: boolean;
  unlocked: boolean;
  /** The user let this site see their wallets and ask for signatures. */
  connected: boolean;
  limits: SiteLimits;
}

export interface SiteWallet {
  id: string;
  name: string;
  evm: string | null;
  solana: SolAddress | null;
  primary: boolean;
  hidden: boolean;
}

/** A Solana instruction on the wire, its data in base64. */
export interface WireInstruction {
  programId: SolAddress;
  keys: { pubkey: SolAddress; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

/** What a Solana transaction the site asks to sign does: one trade, nothing else. */
export interface SolTradeIntent {
  kind: 'trade';
  mint: SolAddress;
  side: 'buy' | 'sell';
  /** pump.fun's route for the coin, or one pool of another program. */
  route: { kind: 'pump' } | { kind: 'dex'; pool: SolAddress };
}

/**
 * A coin the site asks to create on pump.fun, with the dev buy it opens with: the
 * extension builds the transaction again from this and the chain.
 */
export interface SolCreateIntent {
  kind: 'create';
  launchpad: 'pump';
  /** The new coin's address: a key the site made for it, which signs the transaction too. */
  mint: SolAddress;
  name: string;
  symbol: string;
  /** Its metadata JSON. */
  uri: string;
  /** The dev buy in lamports, as a decimal string: '0' for none. */
  devBuy: string;
  /** The least coin units the dev buy takes. */
  minOut: string;
}

export type SolSiteIntent = SolTradeIntent | SolCreateIntent;

export interface SiteSolSign {
  walletId: string;
  blockhash: string;
  instructions: WireInstruction[];
  intent: SolSiteIntent;
}

export interface SiteSolSigned {
  /** Base58: the transaction's id once sent. */
  signature: string;
}

// ── EVM: amounts as decimal strings ─────────────────────────────────────────

/** An EIP-1559 transaction the site asks the extension to sign. */
export interface WireEvmTx {
  chainId: number;
  nonce: number;
  to: string;
  data: string;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

/** The pool a trade is on: the extension finds it again from the chain. */
export interface WireTradeRef {
  token: string;
  venueId: string;
  poolId: string;
  /** On the pool's funding leg (native ↔ its asset). */
  leg?: boolean | undefined;
}

export interface WirePermitSingle {
  details: { token: string; amount: string; expiration: number; nonce: number };
  spender: string;
  sigDeadline: string;
}

export interface WireTransferPermit {
  permitted: { token: string; amount: string };
  nonce: string;
  deadline: string;
}

/** The links a Pons coin keeps on chain (Nesty fills these three of its five). */
export interface WirePonsLinks {
  twitter: string;
  telegram: string;
  website: string;
}

/**
 * A coin the site asks to create on an EVM launchpad, as it built the transaction: the
 * extension builds it again for the signing wallet, which every fee and reward goes to.
 * Amounts in wei; salts are 32 bytes, hex.
 */
export type WireCreateSpec =
  | {
      launchpad: 'flap';
      name: string;
      symbol: string;
      /** The metadata's IPFS CID, from Flap's own upload. */
      meta: string;
      /** Buy and sell tax in bps (0: a standard token). */
      taxBps: number;
      salt: string;
      devBuy: string;
    }
  | {
      launchpad: 'clanker';
      name: string;
      symbol: string;
      image: string;
      /** JSON: description and links. */
      metadata: string;
      salt: string;
      devBuy: string;
    }
  | {
      launchpad: 'klik';
      name: string;
      symbol: string;
      /** The metadata JSON's ipfs:// URI. */
      metadata: string;
      salt: string;
      devBuy: string;
    }
  | {
      launchpad: 'pons';
      name: string;
      symbol: string;
      logo: string;
      description: string;
      links: WirePonsLinks;
      creatorTaxBps: number;
      salt: string;
      /** The launch fee: Pons takes exactly its current one. */
      fee: string;
    };

/**
 * How the site built a transaction, so the extension can build it again and sign only
 * when both are the same: a trade, an approval it needs, a replacement of one, or a new
 * coin.
 */
export type WireTxPurpose =
  | {
      kind: 'swap';
      ref: WireTradeRef;
      side: 'buy' | 'sell';
      amountIn: string;
      minOut: string;
      deadline: string;
      permit?: { permit: WirePermitSingle; signature: string } | undefined;
    }
  | {
      kind: 'router';
      ref: WireTradeRef;
      side: 'buy' | 'sell';
      amountIn: string;
      assetMin: string;
      minOut: string;
      deadline: string;
      permit?: { permit: WireTransferPermit; signature: string } | undefined;
    }
  | { kind: 'approve'; ref: WireTradeRef; asset: string; spender: string; amount: string }
  | { kind: 'replace' }
  | { kind: 'empty' }
  | { kind: 'create'; spec: WireCreateSpec };

export type WirePermitPurpose =
  | { kind: 'permit'; ref: WireTradeRef; permit: WirePermitSingle }
  | { kind: 'transfer'; ref: WireTradeRef; permit: WireTransferPermit; spender: string };

export interface SiteEvmSign {
  walletId: string;
  tx: WireEvmTx;
  purpose: WireTxPurpose;
}

export interface SiteEvmPermit {
  walletId: string;
  chainId: number;
  purpose: WirePermitPurpose;
}

export interface SiteEvmSigned {
  /** 65 bytes, hex: r, s and yParity. */
  signature: string;
}

/**
 * A bridge the site asks for, in the chain's native coin: to one of the user's wallets
 * (`toWalletId`) or to an address typed on the site (`toAddress`), exactly one of the two.
 */
export interface SiteBridgeRequest {
  fromChainId: number;
  toChainId: number;
  /** Decimal, in the source chain's native coin. */
  amount: string;
  fromWalletId: string;
  toWalletId?: string | undefined;
  toAddress?: string | undefined;
}

/** How a bridge the site started stands. */
export interface SiteBridgeStatus {
  /** working, then done once Relay paid out; failed or blocked when the deposit did not go. */
  status: 'working' | 'done' | 'partial' | 'failed' | 'blocked';
  /** Relay's own: waiting → pending → success | failure | refund. */
  relayStatus: string;
  /** The deposit on the source chain: a hash, or a signature on Solana. */
  deposit?: string;
  /** The payout on the destination chain, once there is one. */
  payout?: string;
  error?: string;
}

export type SiteBridgeStarted = { id: string } & SiteBridgeStatus;

/** A price alert the site asks the extension to keep: it fires once the price is reached. */
export type SiteAlertInput = AlertInput;
export type SiteAlert = AlertView;

/** The wallets the site follows and their trades, kept and read by the extension. */
export type SiteTracker = TrackerView;
export type SiteFollowInput = FollowInput;
export type SiteFollowEdit = FollowEdit;

export interface SiteAlerts {
  alerts: SiteAlert[];
  /** The browser does not show the extension's notifications: no alert would be seen. */
  blocked: boolean;
}

/** A request waiting on the user, as the approval window shows it. */
export type SitePendingView = { id: string; origin: string } & (
  | { kind: 'connect' }
  | {
      kind: 'trade';
      walletName: string;
      summary: string;
      usd: number | null;
      /** Why it needs the user: above the confirmation amount, or the minute's budget. */
      why: string;
    }
  /** A new coin: always the user's call. */
  | { kind: 'create'; walletName: string; summary: string; usd: number | null }
  /**
   * A bridge: to the user's own wallet past their thresholds, or to an outside address,
   * which is always their call (with the password above the confirmation amount).
   */
  | {
      kind: 'bridge';
      walletName: string;
      /** What leaves: "0.5 ETH on Base". */
      summary: string;
      /** What arrives: "3.21 SOL on Solana". */
      receive: string;
      usd: number | null;
      toChainId: number;
      /** The address paid, in full. */
      recipient: string;
      /** The user's wallet paid, or null for an outside address. */
      recipientName: string | null;
      needsPassword: boolean;
      /** Why a bridge to their own wallet needs them, or null. */
      why: string | null;
    }
);
