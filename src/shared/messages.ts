import { z } from 'zod';
import { AddressSchema } from './chains/schema';
import type { ResolvedTarget } from './detection';
import { ExitRuleInputSchema, MAX_EXIT_RULES, type ExitPlanView } from './exits';
import type { BlockedAction, PanelState, QuoteSet, TradeTicket } from './panel';
import type {
  ChainSettings,
  GlobalSettings,
  SolanaSettings,
  WalletGroup,
} from './settings/defaults';
import {
  ChainSettingsSchema,
  GlobalSettingsSchema,
  PanelChainPatchSchema,
  PanelSolanaPatchSchema,
  SolanaSettingsSchema,
} from './settings/defaults';
import type {
  SiteAlert,
  SiteAlerts,
  SiteBridgeStarted,
  SiteBridgeStatus,
  SiteEvmSigned,
  SiteHello,
  SitePendingView,
  SiteSolSigned,
  SiteWallet,
} from './site-bridge';
import { SolAddressSchema, isSolana } from './solana';
import type { WalletAccount } from './wallet';

const Id = z.string().min(1).max(64);
const Password = z.string().min(1).max(1024);
const ChainId = z.number().int().positive();
const Decimal = z.string().regex(/^\d{1,30}(\.\d{1,18})?$/);
/** SOL amounts: at most 9 decimals (lamports). */
const SolDecimal = z.string().regex(/^\d{1,12}(\.\d{1,9})?$/);
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
/** An address a bridge pays, 0x or base58: the engine checks it against the chain paid on. */
const PayoutAddress = z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
/** A bridge: to one of the user's wallets, or to an address typed for it. */
const BridgeFields = {
  fromChainId: ChainId,
  toChainId: ChainId,
  amount: Decimal,
  fromWalletId: Id,
  toWalletId: Id.optional(),
  toAddress: PayoutAddress.optional(),
};
const Origin = z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
/** The Nesty website's origin (its local development server is plain http). */
const SiteOrigin = z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/);
const Base64 = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** A Solana instruction from the Nesty website (site-bridge.ts). */
const WireInstructionSchema = z
  .object({
    programId: SolAddressSchema,
    keys: z
      .array(
        z
          .object({ pubkey: SolAddressSchema, isSigner: z.boolean(), isWritable: z.boolean() })
          .strict(),
      )
      .max(64),
    data: Base64,
  })
  .strict();

/** What a transaction the website asks the extension to sign does: one trade. */
const SolTradeIntentSchema = z
  .object({
    kind: z.literal('trade'),
    mint: SolAddressSchema,
    side: z.enum(['buy', 'sell']),
    route: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pump') }).strict(),
      z.object({ kind: z.literal('dex'), pool: SolAddressSchema }).strict(),
    ]),
  })
  .strict();

/** A u64 from the Nesty website, as a decimal string. */
const U64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

/**
 * A coin's text from the create form: bounded here, and held to its launchpad's own
 * limits by create.ts before anything is built.
 */
const CoinText = z.string().max(4096);
const CoinRef = z.string().max(1024);

/** A new pump.fun coin the website asks the extension to sign for (site-bridge.ts). */
const SolCreateIntentSchema = z
  .object({
    kind: z.literal('create'),
    launchpad: z.literal('pump'),
    mint: SolAddressSchema,
    name: CoinText,
    symbol: CoinText,
    uri: CoinRef,
    devBuy: U64,
    minOut: U64,
  })
  .strict();

/** EVM amounts from the Nesty website: unsigned integers as decimal strings. */
const Uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const Uint48 = z
  .number()
  .int()
  .min(0)
  .max(2 ** 48 - 1);
const HexData = z
  .string()
  .max(40_000)
  .regex(/^0x([0-9a-fA-F]{2})*$/);
const Signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Side = z.enum(['buy', 'sell']);

const WireTradeRefSchema = z
  .object({
    token: AddressSchema,
    venueId: z.string().min(1).max(32),
    poolId: z.string().min(1).max(160),
    leg: z.literal(true).optional(),
  })
  .strict();

const WirePermitSingleSchema = z
  .object({
    details: z
      .object({ token: AddressSchema, amount: Uint, expiration: Uint48, nonce: Uint48 })
      .strict(),
    spender: AddressSchema,
    sigDeadline: Uint,
  })
  .strict();

const WireTransferPermitSchema = z
  .object({
    permitted: z.object({ token: AddressSchema, amount: Uint }).strict(),
    nonce: Uint,
    deadline: Uint,
  })
  .strict();

const WireEvmTxSchema = z
  .object({
    chainId: ChainId,
    nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    to: AddressSchema,
    data: HexData,
    value: Uint,
    gas: Uint,
    maxFeePerGas: Uint,
    maxPriorityFeePerGas: Uint,
  })
  .strict();

const Bps = z.number().int().min(0).max(10_000);

/** A new EVM coin from the create form (site-bridge.ts). */
const WireCreateSpecSchema = z.discriminatedUnion('launchpad', [
  z
    .object({
      launchpad: z.literal('flap'),
      name: CoinText,
      symbol: CoinText,
      meta: CoinRef,
      taxBps: Bps,
      salt: Hex32,
      devBuy: Uint,
    })
    .strict(),
  z
    .object({
      launchpad: z.literal('clanker'),
      name: CoinText,
      symbol: CoinText,
      image: CoinRef,
      metadata: CoinText,
      salt: Hex32,
      devBuy: Uint,
    })
    .strict(),
  z
    .object({
      launchpad: z.literal('klik'),
      name: CoinText,
      symbol: CoinText,
      metadata: CoinRef,
      salt: Hex32,
      devBuy: Uint,
    })
    .strict(),
  z
    .object({
      launchpad: z.literal('pons'),
      name: CoinText,
      symbol: CoinText,
      logo: CoinRef,
      description: CoinText,
      links: z.object({ twitter: CoinRef, telegram: CoinRef, website: CoinRef }).strict(),
      creatorTaxBps: Bps,
      salt: Hex32,
      fee: Uint,
    })
    .strict(),
]);

/** What an EVM transaction the website asks the extension to sign is (site-bridge.ts). */
const WireTxPurposeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('swap'),
      ref: WireTradeRefSchema,
      side: Side,
      amountIn: Uint,
      minOut: Uint,
      deadline: Uint,
      permit: z
        .object({ permit: WirePermitSingleSchema, signature: Signature })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('router'),
      ref: WireTradeRefSchema,
      side: Side,
      amountIn: Uint,
      assetMin: Uint,
      minOut: Uint,
      deadline: Uint,
      permit: z
        .object({ permit: WireTransferPermitSchema, signature: Signature })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approve'),
      ref: WireTradeRefSchema,
      asset: AddressSchema,
      spender: AddressSchema,
      amount: Uint,
    })
    .strict(),
  z.object({ kind: z.literal('create'), spec: WireCreateSpecSchema }).strict(),
  z.object({ kind: z.literal('replace') }).strict(),
  z.object({ kind: z.literal('empty') }).strict(),
]);

const WirePermitPurposeSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('permit'), ref: WireTradeRefSchema, permit: WirePermitSingleSchema })
    .strict(),
  z
    .object({
      kind: z.literal('transfer'),
      ref: WireTradeRefSchema,
      permit: WireTransferPermitSchema,
      spender: AddressSchema,
    })
    .strict(),
]);

const DetectionSchema = z
  .object({
    siteId: z.string().max(32),
    kind: z.enum(['token', 'pair', 'unknown']),
    address: AddressSchema.optional(),
    poolId: Hex32.optional(),
    solana: SolAddressSchema.optional(),
    chainId: ChainId.optional(),
  })
  .strict();

/** Where the panel sits on a site, and whether it is folded away. -1 = default position. */
export const PanelPrefsSchema = z
  .object({
    x: z.number().min(-1).max(100_000),
    y: z.number().min(-1).max(100_000),
    minimized: z.boolean(),
    hidden: z.boolean(),
  })
  .strict();
export type PanelPrefs = z.infer<typeof PanelPrefsSchema>;

const TradeTarget = { chainId: ChainId, token: AddressSchema };
/** A token on any network: a 0x address on EVM chains, a mint (base58) on Solana. */
const AnyTarget = { chainId: ChainId, token: z.union([AddressSchema, SolAddressSchema]) };
/** Base58 has no 0, so a mint never starts with 0x. */
const fitsNetwork = (r: { chainId: number; token: string }) =>
  isSolana(r.chainId) !== r.token.startsWith('0x');
const NOT_ITS_NETWORK = 'This token address is not one of that network.';
const WalletIds = z.array(Id).min(1).max(100);
/** A raw integer amount (wei, lamports, token units) as a decimal string. */
const RawAmount = z.string().regex(/^\d{1,78}$/);
/** Epoch ms of the click in the page, for the click → sent timing. */
const ClickedAt = z.number().int().positive().optional();

/**
 * Every request to the background. Parsed with zod before anything else happens.
 * Which sender kinds may use which type is decided by CONTENT_TYPES / FRAME_TYPES below.
 */
export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }).strict(),

  z.object({ type: z.literal('vault.status') }).strict(),
  z
    .object({ type: z.literal('vault.create'), mnemonic: z.string().max(1024), password: Password })
    .strict(),
  z.object({ type: z.literal('vault.unlock'), password: Password }).strict(),
  z.object({ type: z.literal('vault.lock') }).strict(),
  z.object({ type: z.literal('vault.reset'), confirm: z.literal('DELETE') }).strict(),
  z
    .object({ type: z.literal('vault.changePassword'), password: Password, newPassword: Password })
    .strict(),

  z.object({ type: z.literal('wallets.list') }).strict(),
  z.object({ type: z.literal('wallets.add'), name: z.string().max(64).optional() }).strict(),
  z
    .object({
      type: z.literal('wallets.importKey'),
      // A Solana CLI keypair file is a JSON array of 64 numbers.
      privateKey: z.string().max(1000),
      name: z.string().max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal('wallets.rename'), id: Id, name: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('wallets.setHidden'), id: Id, hidden: z.boolean() }).strict(),
  z.object({ type: z.literal('wallets.setPrimary'), id: Id }).strict(),
  z.object({ type: z.literal('wallets.remove'), id: Id }).strict(),
  z
    .object({
      type: z.literal('wallets.exportKey'),
      id: Id,
      password: Password,
      /** Which key: the EVM one (default) or the Solana one of a recovery-phrase wallet. */
      kind: z.enum(['evm', 'solana']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('wallets.balances'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('wallets.distribute'),
      chainId: ChainId,
      /** The wallet the funds come from. */
      hubId: Id,
      walletIds: WalletIds,
      amountEach: Decimal,
    })
    .strict(),
  z
    .object({
      type: z.literal('wallets.collect'),
      chainId: ChainId,
      /** The wallet the funds go to. */
      hubId: Id,
      walletIds: WalletIds,
    })
    .strict(),

  // Send / receive: popup only (not in the content or frame allowlists).
  z
    .object({
      type: z.literal('send.prepare'),
      chainId: ChainId,
      walletId: Id,
      token: AddressSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('send.checkRecipient'), chainId: ChainId, to: AddressSchema })
    .strict(),
  z
    .object({
      type: z.literal('send.execute'),
      chainId: ChainId,
      walletId: Id,
      to: AddressSchema,
      token: AddressSchema.optional(),
      amount: Decimal,
      password: Password.optional(),
    })
    .strict(),

  z.object({ type: z.literal('clipboard.scheduleClear') }).strict(),
  z.object({ type: z.literal('offscreen.done') }).strict(),

  z.object({ type: z.literal('settings.get') }).strict(),
  z.object({ type: z.literal('settings.repairs') }).strict(),
  z
    .object({ type: z.literal('settings.update'), patch: GlobalSettingsSchema.partial().strict() })
    .strict(),
  z.object({ type: z.literal('settings.getChain'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('settings.updateChain'),
      chainId: ChainId,
      patch: ChainSettingsSchema.partial().strict(),
    })
    .strict(),

  z.object({ type: z.literal('history.list') }).strict(),
  // Token approvals on a chain, and revoking one. Popup only.
  z.object({ type: z.literal('approvals.list'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('approvals.revoke'),
      chainId: ChainId,
      walletId: Id,
      token: AddressSchema,
      spender: AddressSchema,
    })
    .strict(),
  // Exit plans (take profit / stop loss), per token.
  z.object({ type: z.literal('exits.list'), chainId: ChainId.optional() }).strict(),
  z
    .object({ type: z.literal('exits.get'), ...AnyTarget })
    .strict()
    .refine(fitsNetwork, NOT_ITS_NETWORK),
  z
    .object({
      type: z.literal('exits.set'),
      ...AnyTarget,
      walletIds: WalletIds,
      rules: z.array(ExitRuleInputSchema).min(1).max(MAX_EXIT_RULES),
    })
    .strict()
    .refine(fitsNetwork, NOT_ITS_NETWORK),
  z
    .object({ type: z.literal('exits.remove'), ...AnyTarget })
    .strict()
    .refine(fitsNetwork, NOT_ITS_NETWORK),
  // Raw total supply of a token, for its market cap. Popup and the PnL card window only.
  z
    .object({ type: z.literal('token.supply'), ...AnyTarget })
    .strict()
    .refine(fitsNetwork, NOT_ITS_NETWORK),
  // A PnL card of what the panel or the popup shows: the figures beside the clicked PnL.
  // The background adds the trades from its own log and opens the card's window.
  z
    .object({
      type: z.literal('share.open'),
      ...AnyTarget,
      symbol: z.string().min(1).max(64),
      decimals: z.number().int().min(0).max(36),
      unit: z
        .object({
          symbol: z.string().min(1).max(16),
          decimals: z.number().int().min(0).max(36),
          mint: SolAddressSchema.nullable(),
          usd: z.number().positive().max(1e9),
        })
        .strict(),
      wallets: z
        .array(
          z
            .object({
              id: Id,
              token: RawAmount,
              cost: z.object({ tokens: RawAmount, costWei: RawAmount }).strict().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      tokenUsd: z.number().positive().max(1e12),
      supply: z.number().positive().max(1e21).optional(),
    })
    .strict()
    .refine(fitsNetwork, NOT_ITS_NETWORK),
  z.object({ type: z.literal('portfolio.get'), chainId: ChainId, walletIds: WalletIds }).strict(),
  z
    .object({ type: z.literal('portfolio.addToken'), chainId: ChainId, token: AddressSchema })
    .strict(),
  z
    .object({
      type: z.literal('portfolio.setTrusted'),
      chainId: ChainId,
      token: AddressSchema,
      trusted: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('logo.get'),
      chainId: ChainId,
      token: z.union([AddressSchema, SolAddressSchema, z.literal('native')]),
    })
    .strict()
    .refine((r) => r.token === 'native' || fitsNetwork(r), NOT_ITS_NETWORK),
  z.object({ type: z.literal('logo.chain'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('bridge.quote'),
      ...BridgeFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('bridge.execute'),
      ...BridgeFields,
      confirmed: z.boolean(),
      password: Password.optional(),
    })
    .strict(),
  z.object({ type: z.literal('ws.status'), chainId: ChainId }).strict(),

  z.object({ type: z.literal('sites.status'), origin: Origin }).strict(),
  z.object({ type: z.literal('sites.enable'), origin: Origin, tabId: z.number().int() }).strict(),
  z.object({ type: z.literal('sites.disable'), origin: Origin }).strict(),

  // Panel (content script)
  z.object({ type: z.literal('panel.resolve'), detection: DetectionSchema }).strict(),
  z.object({ type: z.literal('panel.state'), ...TradeTarget }).strict(),
  z
    .object({
      type: z.literal('panel.quotes'),
      ...TradeTarget,
      buyAmounts: z.array(Decimal).max(8),
      sellBps: z.array(z.number().int().min(1).max(10_000)).max(8),
    })
    .strict(),
  z.object({ type: z.literal('rpc.warm'), chainId: ChainId }).strict(),
  z.object({ type: z.literal('panel.selectWallets'), walletIds: WalletIds }).strict(),
  // How a buy amount applies across several wallets: in each, or split between them.
  z.object({ type: z.literal('panel.setMultiWallet'), mode: z.enum(['each', 'split']) }).strict(),
  // Saves the wallets the panel trades with as a named group.
  z
    .object({
      type: z.literal('panel.saveGroup'),
      name: z.string().trim().min(1).max(24),
      walletIds: WalletIds,
    })
    .strict(),
  z
    .object({
      type: z.literal('panel.setTrade'),
      chainId: ChainId,
      patch: PanelChainPatchSchema,
    })
    .strict(),
  // Panel position per site; the site is the sender's own origin, never a field.
  z.object({ type: z.literal('panel.getPrefs') }).strict(),
  z.object({ type: z.literal('panel.setPrefs'), prefs: PanelPrefsSchema }).strict(),

  // Trading (content script; every transaction still passes the validator)
  z
    .object({
      type: z.literal('trade.buy'),
      ...TradeTarget,
      amount: Decimal,
      walletIds: WalletIds,
      mode: z.enum(['each', 'split']),
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  z
    .object({
      type: z.literal('trade.sell'),
      ...TradeTarget,
      bps: z.number().int().min(1).max(10_000),
      walletIds: WalletIds,
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  z.object({ type: z.literal('trade.speedUp'), ticketId: Id, walletId: Id }).strict(),
  z.object({ type: z.literal('trade.cancel'), ticketId: Id, walletId: Id }).strict(),
  // Fills the missing nonce a sent transaction is queued behind, with an empty transfer.
  z.object({ type: z.literal('trade.unstick'), ticketId: Id, walletId: Id }).strict(),

  // Solana (pump.fun): the panel's requests by mint, and its own settings.
  z.object({ type: z.literal('sol.panel.state'), mint: SolAddressSchema }).strict(),
  z
    .object({
      type: z.literal('sol.panel.quotes'),
      mint: SolAddressSchema,
      buyAmounts: z.array(SolDecimal).max(8),
      sellBps: z.array(z.number().int().min(1).max(10_000)).max(8),
    })
    .strict(),
  z.object({ type: z.literal('sol.panel.setTrade'), patch: PanelSolanaPatchSchema }).strict(),
  z.object({ type: z.literal('sol.rpc.warm') }).strict(),
  z
    .object({
      type: z.literal('sol.trade.buy'),
      mint: SolAddressSchema,
      amount: SolDecimal,
      walletIds: WalletIds,
      mode: z.enum(['each', 'split']),
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  z
    .object({
      type: z.literal('sol.trade.sell'),
      mint: SolAddressSchema,
      bps: z.number().int().min(1).max(10_000),
      walletIds: WalletIds,
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  // Popup only.
  z
    .object({
      type: z.literal('sol.portfolio.setTrusted'),
      mint: SolAddressSchema,
      trusted: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sol.send.prepare'),
      walletId: Id,
      mint: SolAddressSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sol.send.checkRecipient'),
      to: SolAddressSchema,
      mint: SolAddressSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sol.send.execute'),
      walletId: Id,
      to: SolAddressSchema,
      mint: SolAddressSchema.optional(),
      amount: SolDecimal,
      password: Password.optional(),
    })
    .strict(),
  z.object({ type: z.literal('sol.settings.get') }).strict(),
  z
    .object({
      type: z.literal('sol.settings.update'),
      patch: SolanaSettingsSchema.partial().strict(),
    })
    .strict(),

  // The Nesty website (SITE_TYPES): connecting, its wallet list, signing its trades.
  z.object({ type: z.literal('site.hello') }).strict(),
  z.object({ type: z.literal('site.connect') }).strict(),
  z.object({ type: z.literal('site.disconnect') }).strict(),
  z.object({ type: z.literal('site.wallets') }).strict(),
  z.object({ type: z.literal('site.unlock') }).strict(),
  z
    .object({
      type: z.literal('site.sol.sign'),
      walletId: Id,
      blockhash: z.string().min(32).max(44),
      instructions: z.array(WireInstructionSchema).min(1).max(16),
      intent: z.discriminatedUnion('kind', [SolTradeIntentSchema, SolCreateIntentSchema]),
    })
    .strict(),
  z
    .object({
      type: z.literal('site.evm.sign'),
      walletId: Id,
      tx: WireEvmTxSchema,
      purpose: WireTxPurposeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('site.evm.permit'),
      walletId: Id,
      chainId: ChainId,
      purpose: WirePermitPurposeSchema,
    })
    .strict(),
  z.object({ type: z.literal('site.bridge.quote'), ...BridgeFields }).strict(),
  z.object({ type: z.literal('site.bridge.send'), ...BridgeFields }).strict(),
  z.object({ type: z.literal('site.bridge.status'), id: Id }).strict(),
  z.object({ type: z.literal('site.alerts.list') }).strict(),
  z
    .object({
      type: z.literal('site.alerts.set'),
      chainId: ChainId,
      // Checked against its chain by the alert watcher.
      token: z.string().min(32).max(44),
      symbol: z.string().max(64),
      above: z.boolean(),
      price: z.number().positive().max(1e15),
      supply: z.number().positive().max(1e21).optional(),
    })
    .strict(),
  z.object({ type: z.literal('site.alerts.remove'), id: Id }).strict(),
  // The approval window and the popup only.
  z.object({ type: z.literal('site.pending'), id: Id }).strict(),
  z
    .object({
      type: z.literal('site.decide'),
      id: Id,
      approve: z.boolean(),
      // A bridge to an outside address above the confirmation amount needs it.
      password: Password.optional(),
    })
    .strict(),
  z.object({ type: z.literal('site.connections') }).strict(),
  z.object({ type: z.literal('site.revoke'), origin: SiteOrigin }).strict(),
]);
export type Request = z.infer<typeof RequestSchema>;
export type RequestType = Request['type'];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

/** Requests a content script on a trading page may send. Never anything touching keys. */
export const CONTENT_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'panel.resolve',
  'panel.state',
  'panel.quotes',
  'rpc.warm',
  'panel.selectWallets',
  'panel.setMultiWallet',
  'panel.saveGroup',
  'panel.setTrade',
  'panel.getPrefs',
  'panel.setPrefs',
  'trade.buy',
  'trade.sell',
  'trade.speedUp',
  'trade.cancel',
  'trade.unstick',
  'exits.get',
  'exits.set',
  'exits.remove',
  'sol.panel.state',
  'sol.panel.quotes',
  'sol.panel.setTrade',
  'sol.rpc.warm',
  'sol.trade.buy',
  'sol.trade.sell',
  'share.open',
]);

/**
 * Requests the Nesty website may send, through its own content script. Signing is for
 * trades only, each checked again in the background; no key ever leaves.
 */
export const SITE_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'site.hello',
  'site.connect',
  'site.disconnect',
  'site.wallets',
  'site.unlock',
  'site.sol.sign',
  'site.evm.sign',
  'site.evm.permit',
  'site.bridge.quote',
  'site.bridge.send',
  'site.bridge.status',
  'site.alerts.list',
  'site.alerts.set',
  'site.alerts.remove',
]);

/** Requests an extension page embedded as an iframe inside a trading page may send. */
export const FRAME_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'vault.unlock',
]);

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface PingResponse {
  version: string;
  locked: boolean;
}

export interface WalletBalanceView {
  id: string;
  native: string;
}

export interface BridgeQuoteView {
  /** Raw destination amount, in its native units (wei, or lamports on Solana). */
  amountOut: string;
  /** The least Relay commits to pay out (same units); below it the deposit is refunded. */
  minOut: string;
  slippageBps: number;
  feeUsd: number | null;
  timeEstimateS: number | null;
  amountInUsd: number | null;
}

export interface WsStatusView {
  state: 'off' | 'connecting' | 'connected' | 'error';
  lastBlockAt: number | null;
}

export interface PortfolioTokenView {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  perWallet: Record<string, string>;
  total: string;
  valueUsd: number | null;
  dust: boolean;
  /** Received without being bought or added: likely airdrop spam, hidden by default. */
  unsolicited: boolean;
  /** Per wallet: tokens bought through Nesty and still open, and their native cost. */
  cost?: Record<string, { tokens: string; costWei: string }>;
  /**
   * Solana: the cost is in the token the coin is bought with (USDC, say), at this USD price,
   * rather than in SOL.
   */
  costUnit?: { usd: number | null; decimals: number; symbol: string; mint: string };
  /** Total supply (raw), where the portfolio read it with the token (Solana mints). */
  supply?: string;
}

/** One wallet's standing ERC-20 allowance to a spender Nesty uses. */
export interface ApprovalView {
  walletId: string;
  walletName: string;
  token: string;
  symbol: string;
  decimals: number;
  spender: string;
  /** What the spender is: Permit2, a router or a launchpad. */
  spenderLabel: string;
  /** Raw allowance. */
  amount: string;
  unlimited: boolean;
}

export interface Portfolio {
  chainId: number;
  nativeUsd: number | null;
  native: Record<string, string>;
  tokens: PortfolioTokenView[];
}

export interface SendPrep {
  /** Estimated network fee for the send (wei). */
  feeWei: string;
  /** Largest amount that can be sent (raw units), leaving the fee for native sends. */
  maxAmount: string;
  /**
   * SOL sends: the least a wallet may hold other than nothing, its rent exemption
   * (lamports). Read from the chain, which lowers it now and then.
   */
  minBalance?: string;
}

/** What a Solana address is on chain, for the Send form's checks. */
export type SolRecipientKind =
  /** A plain account: someone's wallet. */
  | 'wallet'
  /** Nothing there yet: a new wallet, or a mistyped address. */
  | 'unused'
  | 'program'
  /** A token's mint. */
  | 'mint'
  /** A token account: the wallet that owns it is the one to send to. */
  | 'token-account'
  /** Held by a program (a vault, a deposit address), or an address no key can sign for. */
  | 'program-account';

export interface SolRecipientCheck {
  /** Name of your wallet with this address, if it is one. */
  ownName: string | null;
  kind: SolRecipientKind;
  /** For a token account: the wallet that owns it. */
  owner: string | null;
  /** For a mint: its symbol. */
  mintSymbol: string | null;
  /** A previous Send went to this address. */
  sentBefore: boolean;
  /** Token sends: rent of the recipient's token account, which you pay ('0' when it exists). */
  tokenAccountRent?: string;
}

export interface RecipientCheck {
  /** Name of your wallet with this address, if it is one. */
  ownName: string | null;
  /** Has code: an exchange deposit or smart wallet is fine, a token contract is not. */
  contract: boolean;
  /** Symbol when the address is a token contract (funds sent there are usually lost). */
  tokenSymbol: string | null;
  /** A previous Send went to this address. */
  sentBefore: boolean;
}

export interface SiteStatus {
  builtin: boolean;
  enabled: boolean;
}

export interface ResponseMap {
  ping: PingResponse;
  'vault.status': VaultStatus;
  'vault.create': WalletAccount[];
  'vault.unlock': WalletAccount[];
  'vault.lock': null;
  'vault.reset': null;
  'vault.changePassword': null;
  'wallets.list': WalletAccount[];
  'wallets.add': WalletAccount;
  'wallets.importKey': WalletAccount;
  'wallets.rename': null;
  'wallets.setHidden': null;
  'wallets.setPrimary': null;
  'wallets.remove': null;
  'wallets.exportKey': { privateKey: string };
  'wallets.balances': WalletBalanceView[];
  'wallets.distribute': TradeTicket;
  'wallets.collect': TradeTicket;
  'send.prepare': SendPrep;
  'send.checkRecipient': RecipientCheck;
  'send.execute': TradeTicket;
  'clipboard.scheduleClear': null;
  'offscreen.done': null;
  'settings.get': GlobalSettings;
  /** Saved settings that were invalid and fell back to their defaults. */
  'settings.repairs': string[];
  'settings.update': GlobalSettings;
  'settings.getChain': ChainSettings;
  'settings.updateChain': ChainSettings;
  'history.list': TradeTicket[];
  'token.supply': string | null;
  'share.open': null;
  'approvals.list': ApprovalView[];
  'exits.list': ExitPlanView[];
  'exits.get': ExitPlanView | null;
  'exits.set': ExitPlanView;
  'exits.remove': null;
  'approvals.revoke': { hash: string; confirmed: boolean };
  'portfolio.get': Portfolio;
  'portfolio.addToken': null;
  'portfolio.setTrusted': null;
  'logo.get': string | null;
  'logo.chain': string | null;
  'bridge.quote': BridgeQuoteView;
  'bridge.execute': TradeTicket;
  'ws.status': WsStatusView;
  'sites.status': SiteStatus;
  'sites.enable': SiteStatus;
  'sites.disable': SiteStatus;
  'panel.resolve': ResolvedTarget | null;
  'panel.state': PanelState;
  'panel.quotes': QuoteSet;
  'rpc.warm': null;
  'panel.selectWallets': null;
  'panel.setMultiWallet': null;
  'panel.saveGroup': WalletGroup;
  'panel.setTrade': null;
  'panel.getPrefs': PanelPrefs;
  'panel.setPrefs': null;
  'trade.buy': TradeTicket;
  'trade.sell': TradeTicket;
  'trade.speedUp': TradeTicket;
  'trade.cancel': TradeTicket;
  'trade.unstick': TradeTicket;
  'sol.panel.state': PanelState;
  'sol.panel.quotes': QuoteSet;
  'sol.panel.setTrade': null;
  'sol.rpc.warm': null;
  'sol.trade.buy': TradeTicket;
  'sol.trade.sell': TradeTicket;
  'sol.portfolio.setTrusted': null;
  'sol.send.prepare': SendPrep;
  'sol.send.checkRecipient': SolRecipientCheck;
  'sol.send.execute': TradeTicket;
  'sol.settings.get': SolanaSettings;
  'sol.settings.update': SolanaSettings;
  'site.hello': SiteHello;
  'site.connect': SiteWallet[];
  'site.disconnect': null;
  'site.wallets': SiteWallet[];
  'site.unlock': null;
  'site.sol.sign': SiteSolSigned;
  'site.evm.sign': SiteEvmSigned;
  'site.evm.permit': SiteEvmSigned;
  'site.bridge.quote': BridgeQuoteView;
  'site.bridge.send': SiteBridgeStarted;
  'site.bridge.status': SiteBridgeStatus | null;
  'site.alerts.list': SiteAlerts;
  'site.alerts.set': SiteAlert;
  'site.alerts.remove': null;
  'site.pending': SitePendingView | null;
  'site.decide': null;
  'site.connections': { origin: string; at: number }[];
  'site.revoke': null;
}

export type ErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'internal'
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
  | 'no_evm'
  | 'unsupported_chain'
  | 'no_route'
  | 'needs_confirmation'
  | 'needs_password'
  | 'limit_exceeded'
  | 'tax_too_high'
  | 'insufficient_funds'
  | 'blocked'
  | 'rpc'
  | 'permission_denied'
  | 'invalid_settings'
  | 'not_connected'
  | 'rejected'
  | 'too_many_alerts';

export type Result<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: ErrorCode;
      retryAfterMs?: number;
      detail?: string;
      /** A refused transaction's decoded actions. */
      actions?: BlockedAction[];
    };

export const ResultEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    retryAfterMs: z.number().optional(),
    detail: z.string().optional(),
    actions: z
      .array(z.object({ label: z.string(), ok: z.boolean(), reason: z.string().optional() }))
      .optional(),
  }),
]);

/** Background → content script push events (via tabs.sendMessage). */
export type PushEvent =
  | { kind: 'nesty.vault'; unlocked: boolean }
  | { kind: 'nesty.ticket'; ticket: TradeTicket }
  | { kind: 'nesty.block'; chainId: number };
