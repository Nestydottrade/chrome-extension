import { z } from 'zod';
import type { ChainConfig, GasPreset } from '../chains';

/** Groups switch with Alt + 1–9, so there are at most nine. */
export const MAX_WALLET_GROUPS = 9;

/** A saved set of wallets to trade with, picked in one tap (or Alt + its number). */
export const WalletGroupSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(24),
  walletIds: z.array(z.string()).min(1).max(100),
  /** How a buy amount applies across the group; absent follows the global setting. */
  mode: z.enum(['each', 'split']).optional(),
});
export type WalletGroup = z.infer<typeof WalletGroupSchema>;

/**
 * Global settings. Defaults are deliberately conservative because the extension runs
 * against mainnet from day one: small USD limits and pre-sign simulation on.
 */
export const GlobalSettingsSchema = z.object({
  maxUsdPerTx: z.number().positive(),
  maxUsdPerClick: z.number().positive(),
  /** One-click actions above this USD value ask for confirmation first. */
  confirmAboveUsd: z.number().nonnegative(),
  /** Expected gas fee per transaction, in USD, above which nothing is signed. */
  maxGasUsd: z.number().positive(),
  autoLockMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  simulateBeforeSign: z.boolean(),
  hotkeysEnabled: z.boolean(),
  priceImpactWarnBps: z.number().int().positive(),
  priceImpactDangerBps: z.number().int().positive(),
  maxQuoteAgeMs: z.number().int().positive(),
  quoteRefreshMs: z.number().int().min(900),
  /**
   * Approve a token's sell spender once for the maximum, so later sells and buys never
   * need another approval. Off: bounded to holdings plus approvalBufferBps.
   */
  unlimitedApprovals: z.boolean(),
  /** Extra headroom on bounded approvals, on top of the amount held. */
  approvalBufferBps: z.number().int().min(0).max(10_000),
  multiWalletMode: z.enum(['each', 'split']),
  /** Random 0..N ms delay between wallets in a multi-wallet trade. 0 = off. */
  jitterMaxMs: z.number().int().min(0).max(300),
  /**
   * In a multi-wallet buy, each wallet buys up to this much less than its amount, at random,
   * so wallets that buy together do not all spend the same. Never more. 0 = off.
   */
  buyVarianceBps: z.number().int().min(0).max(5_000),
  selectedWalletIds: z.array(z.string()).max(100),
  walletGroups: z.array(WalletGroupSchema).max(MAX_WALLET_GROUPS),
  /** Use the DEX Screener API as a pool index (results are verified on-chain). */
  usePoolIndex: z.boolean(),
  /** Ask KyberSwap for a route when no pool Nesty knows can trade the token. */
  useAggregator: z.boolean(),
  /** Fetch token logos from DEX Screener's image CDN (reveals which tokens you look at). */
  showTokenLogos: z.boolean(),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = GlobalSettingsSchema.parse({
  maxUsdPerTx: 25,
  maxUsdPerClick: 50,
  confirmAboveUsd: 20,
  maxGasUsd: 10,
  autoLockMinutes: 15,
  simulateBeforeSign: true,
  // Off until the user turns them on: 1–4 buy instantly on any trading page.
  hotkeysEnabled: false,
  priceImpactWarnBps: 200,
  priceImpactDangerBps: 500,
  maxQuoteAgeMs: 6_000,
  quoteRefreshMs: 900,
  unlimitedApprovals: true,
  approvalBufferBps: 1_000,
  multiWalletMode: 'each',
  jitterMaxMs: 0,
  buyVarianceBps: 0,
  selectedWalletIds: [],
  walletGroups: [],
  usePoolIndex: true,
  useAggregator: true,
  showTokenLogos: true,
});

const HttpsUrl = z.url({ protocol: /^https$/ });

const Decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

const DEFAULT_QUICK_SELL_BPS = [2500, 5000, 7500, 10_000] as const;

export const PRIORITY_LEVELS = ['low', 'medium', 'high'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number] | 'custom';

/** Slippage shortcuts shown in the panel; any other value is "custom". */
export const SLIPPAGE_CHOICES_BPS = [1000, 2000, 4000] as const;
/** Max tax chips in the panel; 10 000 means no limit. */
export const MAX_TAX_CHOICES_BPS = [500, 1000, 2000] as const;

/** No two quick buttons may do the same thing (they share a hotkey slot and a busy state). */
const allDifferent = (xs: readonly (string | number)[]) =>
  new Set(xs.map((x) => Number(x))).size === xs.length;
export const QUICK_VALUES_DIFFER = 'The four quick values must all be different.';

export const ChainSettingsSchema = z.object({
  quickBuyAmounts: z.array(Decimal).length(4).refine(allDifferent, QUICK_VALUES_DIFFER),
  /** Quick-sell sizes in basis points of the holding (2500 = 25%). */
  quickSellBps: z
    .array(z.number().int().min(1).max(10_000))
    .length(4)
    .refine(allDifferent, QUICK_VALUES_DIFFER),
  /** Slippage tolerance in basis points (100 = 1%). */
  slippageBps: z.number().int().min(1).max(5000),
  priority: z.enum(['low', 'medium', 'high', 'custom']),
  /** Priority fee (gwei) behind Low / Medium / High. */
  priorityGwei: z.object({ low: Decimal, medium: Decimal, high: Decimal }),
  customPriorityGwei: Decimal,
  /** maxFeePerGas = baseFee × this + priority fee. */
  maxFeeMultiplier: z.number().min(1).max(10),
  /** Optional user RPC, tried before the built-in public ones. */
  customRpc: HttpsUrl.or(z.literal('')),
  /** Optional WebSocket RPC for new-block streaming (confirmations, per-block refresh). */
  wsRpc: z.url({ protocol: /^wss$/ }).or(z.literal('')),
  mevEnabled: z.boolean(),
  /** Buys are refused when the measured token tax (buy or sell) is above this. 10 000 = off. */
  maxTaxBps: z.number().int().min(0).max(10_000),
  /** Private RPC used for sending when MEV protection is on (Ethereum/BSC only). */
  mevRpc: HttpsUrl.or(z.literal('')),
});
export type ChainSettings = z.infer<typeof ChainSettingsSchema>;

/** Fields the trading panel may change directly (never RPC URLs). */
export const PanelChainPatchSchema = ChainSettingsSchema.pick({
  quickBuyAmounts: true,
  quickSellBps: true,
  slippageBps: true,
  priority: true,
  customPriorityGwei: true,
  mevEnabled: true,
  maxTaxBps: true,
})
  .partial()
  .strict();

export function defaultChainSettings(chain: ChainConfig): ChainSettings {
  const g = chain.gasPresets;
  return {
    quickBuyAmounts: [...chain.quickBuyAmounts],
    quickSellBps: [...DEFAULT_QUICK_SELL_BPS],
    slippageBps: 1000,
    priority: 'medium',
    priorityGwei: {
      low: g.p1.priorityFeeGwei,
      medium: g.p2.priorityFeeGwei,
      high: g.p3.priorityFeeGwei,
    },
    customPriorityGwei: g.p2.priorityFeeGwei,
    maxFeeMultiplier: g.p2.maxFeeMultiplier,
    customRpc: '',
    wsRpc: '',
    mevEnabled: chain.mev.supported,
    maxTaxBps: 10_000,
    mevRpc: chain.mev.supported ? (chain.mev.defaultRpc ?? '') : '',
  };
}

/** SOL amounts: at most 9 decimals (lamports). */
const SolDecimal = z.string().regex(/^\d{1,12}(\.\d{1,9})?$/);
/** Dollar amounts: whole cents at most. */
const UsdDecimal = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);

/**
 * Solana's own settings (stored apart from the EVM chains'): amounts in SOL, and the
 * priority fee as SOL per transaction, which is what Solana wallets show.
 */
export const SolanaSettingsSchema = z.object({
  quickBuyAmounts: z.array(SolDecimal).length(4).refine(allDifferent, QUICK_VALUES_DIFFER),
  /**
   * Quick-buy amounts in USD for coins bought with a token rather than SOL (one paired with
   * USDC, say): the panel shows them in that token, at its price.
   */
  quickBuyUsd: z.array(UsdDecimal).length(4).refine(allDifferent, QUICK_VALUES_DIFFER),
  quickSellBps: z
    .array(z.number().int().min(1).max(10_000))
    .length(4)
    .refine(allDifferent, QUICK_VALUES_DIFFER),
  slippageBps: z.number().int().min(1).max(5000),
  priority: z.enum(['low', 'medium', 'high', 'custom']),
  /** Priority fee (SOL per transaction) behind Low / Medium / High. */
  priorityFeeSol: z.object({ low: SolDecimal, medium: SolDecimal, high: SolDecimal }),
  customPriorityFeeSol: SolDecimal,
  /** Optional user RPC, tried before the built-in public ones. */
  customRpc: HttpsUrl.or(z.literal('')),
});
export type SolanaSettings = z.infer<typeof SolanaSettingsSchema>;

/** Fields the trading panel may change directly on Solana (never the RPC). */
export const PanelSolanaPatchSchema = SolanaSettingsSchema.pick({
  quickBuyAmounts: true,
  quickBuyUsd: true,
  quickSellBps: true,
  slippageBps: true,
  priority: true,
  customPriorityFeeSol: true,
})
  .partial()
  .strict();

/**
 * The trade settings the Nesty website keeps for itself, which a trade it asks the extension
 * to make runs with in place of the extension's own: slippage, priority, the tax limit and
 * private sending. Never an RPC, a limit, the gas cap or the approvals: those stay the
 * user's settings here, for every trade.
 */
export const TradePrefsSchema = z
  .object({
    chain: ChainSettingsSchema.pick({
      slippageBps: true,
      priority: true,
      priorityGwei: true,
      customPriorityGwei: true,
      mevEnabled: true,
      maxTaxBps: true,
    })
      .partial()
      .strict()
      .optional(),
    solana: SolanaSettingsSchema.pick({
      slippageBps: true,
      priority: true,
      priorityFeeSol: true,
      customPriorityFeeSol: true,
    })
      .partial()
      .strict()
      .optional(),
    global: GlobalSettingsSchema.pick({ jitterMaxMs: true, buyVarianceBps: true })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type TradePrefs = z.infer<typeof TradePrefsSchema>;

/** Stored settings with what one trade carried in their place (TradePrefs). */
export function withPrefs<T extends object>(
  stored: T,
  carried: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  if (!carried) return stored;
  const set = Object.entries(carried).filter(([, v]) => v !== undefined);
  return set.length > 0 ? { ...stored, ...Object.fromEntries(set) } : stored;
}

export const DEFAULT_SOLANA_SETTINGS: SolanaSettings = SolanaSettingsSchema.parse({
  quickBuyAmounts: ['0.05', '0.1', '0.25', '0.5'],
  quickBuyUsd: ['10', '25', '50', '100'],
  quickSellBps: [...DEFAULT_QUICK_SELL_BPS],
  slippageBps: 1000,
  priority: 'medium',
  priorityFeeSol: { low: '0.0001', medium: '0.0005', high: '0.002' },
  customPriorityFeeSol: '0.0005',
  customRpc: '',
});

/** The priority fee a Solana trade pays right now, in SOL. */
export function solanaPriorityFee(s: SolanaSettings): string {
  return s.priority === 'custom' ? s.customPriorityFeeSol : s.priorityFeeSol[s.priority];
}

/** The gas/slippage parameters a trade uses right now. */
export function effectivePreset(cs: ChainSettings): GasPreset {
  return {
    priorityFeeGwei:
      cs.priority === 'custom' ? cs.customPriorityGwei : cs.priorityGwei[cs.priority],
    maxFeeMultiplier: cs.maxFeeMultiplier,
    slippageBps: cs.slippageBps,
  };
}
