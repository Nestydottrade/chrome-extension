import type { Address } from 'viem';
import { chainLabel, getChain } from '../shared/chains';
import type { EvmTarget, SolanaTarget } from '../shared/detection';
import type { RequestOf } from '../shared/messages';
import { SOLANA, isSolana, solscanTokenUrl } from '../shared/solana';
import { send } from './api';

type TradePatch = RequestOf<'panel.setTrade'>['patch'];
/** A trade-settings change: Solana also keeps USD quick-buy amounts, for coins bought with a token. */
export type SavedTradePatch = TradePatch & { quickBuyUsd?: string[] };

/** What a trading request needs of a target: where it trades and the token. */
export type TargetRef =
  Pick<EvmTarget, 'kind' | 'chainId' | 'token'> | Pick<SolanaTarget, 'kind' | 'chainId' | 'mint'>;

/** Where a target trades, as the panel and popup show it: names, native units, token link. */
export interface Network {
  label: string;
  native: string;
  nativeDecimals: number;
  tokenUrl: string;
}

/** The traded token's address: the EVM contract, or the Solana mint. */
export function tokenId(t: TargetRef): string {
  return t.kind === 'solana' ? t.mint : t.token;
}

export function networkOf(t: TargetRef): Network | null {
  if (t.kind === 'solana')
    return {
      label: SOLANA.name,
      native: SOLANA.nativeCurrency.symbol,
      nativeDecimals: SOLANA.nativeCurrency.decimals,
      tokenUrl: solscanTokenUrl(t.mint),
    };
  const chain = getChain(t.chainId);
  return chain
    ? {
        label: chainLabel(chain),
        native: chain.nativeCurrency.symbol,
        nativeDecimals: chain.nativeCurrency.decimals,
        tokenUrl: `${chain.explorer.url}/token/${t.token}`,
      }
    : null;
}

/** A token the popup opened by chain and address. */
export function refOf(chainId: number, token: string): TargetRef {
  return isSolana(chainId)
    ? { kind: 'solana', chainId, mint: token }
    : { chainId, token: token as Address };
}

interface TradeArgs {
  walletIds: string[];
  confirmed: boolean;
  clickedAt: number;
}

/**
 * Trading requests for a target, from the panel or the popup: Solana tokens go to the
 * `sol.*` handlers by mint, EVM tokens to the chain's. Both answer with the same shapes.
 */
export const panelApi = {
  state: (t: TargetRef) =>
    t.kind === 'solana'
      ? send({ type: 'sol.panel.state', mint: t.mint })
      : send({ type: 'panel.state', chainId: t.chainId, token: t.token }),

  quotes: (t: TargetRef, buyAmounts: string[], sellBps: number[]) =>
    t.kind === 'solana'
      ? send({ type: 'sol.panel.quotes', mint: t.mint, buyAmounts, sellBps })
      : send({ type: 'panel.quotes', chainId: t.chainId, token: t.token, buyAmounts, sellBps }),

  buy: (t: TargetRef, a: TradeArgs & { amount: string; mode: 'each' | 'split' }) =>
    t.kind === 'solana'
      ? send({ type: 'sol.trade.buy', mint: t.mint, ...a })
      : send({ type: 'trade.buy', chainId: t.chainId, token: t.token, ...a }),

  sell: (t: TargetRef, a: TradeArgs & { bps: number }) =>
    t.kind === 'solana'
      ? send({ type: 'sol.trade.sell', mint: t.mint, ...a })
      : send({ type: 'trade.sell', chainId: t.chainId, token: t.token, ...a }),

  /** Solana keeps only what applies there: no MEV, tax limit or gwei. */
  setTrade: (t: TargetRef, patch: SavedTradePatch) => {
    const { quickBuyUsd, ...evm } = patch;
    if (t.kind !== 'solana')
      return send({ type: 'panel.setTrade', chainId: t.chainId, patch: evm });
    const { quickBuyAmounts, quickSellBps, slippageBps } = patch;
    return send({
      type: 'sol.panel.setTrade',
      patch: {
        ...(quickBuyAmounts && { quickBuyAmounts }),
        ...(quickBuyUsd && { quickBuyUsd }),
        ...(quickSellBps && { quickSellBps }),
        ...(slippageBps !== undefined && { slippageBps }),
      },
    });
  },

  warm: (chainId: number) =>
    isSolana(chainId) ? send({ type: 'sol.rpc.warm' }) : send({ type: 'rpc.warm', chainId }),
};
