import { formatUnits } from 'viem';
import { formatUsd } from '../../shared/format';
import type { PortfolioTokenView } from '../../shared/messages';
import { unrealisedPnl } from '../../shared/pnl';

/** Raw amount of a token held across the given wallets. */
export function heldBy(t: PortfolioTokenView, ids: string[]): bigint {
  return ids.reduce((s, id) => s + BigInt(t.perWallet[id] ?? '0'), 0n);
}

/** The part of a token's value that an amount of it is worth. */
export function valueOf(t: PortfolioTokenView, amount: bigint): number | null {
  const total = BigInt(t.total);
  if (t.valueUsd === null || total === 0n) return null;
  return (t.valueUsd * Number(amount)) / Number(total);
}

/** Open PnL of what the wallets bought of a token through Nesty; null without cost or price. */
export function pnlOf(
  t: PortfolioTokenView,
  ids: string[],
  nativeUsd: number | null,
  nativeDecimals = 18,
) {
  const amount = Number(formatUnits(BigInt(t.total), t.decimals));
  if (!t.cost || !t.valueUsd || amount <= 0) return null;
  return unrealisedPnl(
    ids.map((id) => {
      const cost = t.cost?.[id];
      return { token: t.perWallet[id] ?? '0', ...(cost ? { cost } : {}) };
    }),
    t.decimals,
    t.valueUsd / amount,
    // A Solana coin bought with a token cost that token, not the native coin.
    t.costUnit ? t.costUnit.usd : nativeUsd,
    t.costUnit?.decimals ?? nativeDecimals,
  );
}

export const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}${formatUsd(Math.abs(v))}`;
