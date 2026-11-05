import { alertSlug, alertToken } from '../shared/alerts';
import { formatCompact } from '../shared/format';
import { isNestySite } from '../shared/nesty-site';
import { nativeSymbol, networkLabel } from '../shared/networks';
import {
  coinAmount,
  shortAddress,
  type FollowedWallet,
  type TrackedTrade,
} from '../shared/tracker';

/**
 * A followed wallet's trade as a notification: what it says, its id, and what a click on
 * it opens. Background only: the website bundles src/shared/tracker.ts, and this reads the
 * extension's list of trusted sites.
 */

/** What a trade's notification says: "Curve sniper bought AAPLCAT", "2.40 SOL ($412) at $84.2K MC on Solana". */
export function tradeText(
  who: Pick<FollowedWallet, 'name' | 'address'>,
  t: TrackedTrade,
): { title: string; message: string } {
  const coin = t.symbol ?? shortAddress(t.token);
  const title = `${who.name || shortAddress(who.address)} ${t.side === 'buy' ? 'bought' : 'sold'} ${coin}`;
  const usd = t.usd !== null ? `$${formatCompact(t.usd)}` : null;
  const amount =
    t.native !== null
      ? `${coinAmount(t.native)} ${nativeSymbol(t.chainId)}${usd ? ` (${usd})` : ''}`
      : (usd ?? `${formatCompact(t.tokens)} ${coin}`);
  const cap = t.mcap !== null ? ` at $${formatCompact(t.mcap)} MC` : '';
  return { title, message: `${amount}${cap} on ${networkLabel(t.chainId)}` };
}

const NOTE = 'track';

/** A trade's notification id: what its click and its buttons need. */
export const trackNoteId = (w: Pick<FollowedWallet, 'id' | 'origin'>, t: TrackedTrade): string =>
  [NOTE, w.id, String(t.chainId), t.token, t.hash.slice(0, 24), w.origin].join('|');

/**
 * What a tracker notification points at: its coin's page on the Nesty site that follows
 * the wallet, and the wallet (for Mute). Null for any other notification.
 */
export function trackNote(
  noteId: string,
): { page: string; walletId: string; origin: string } | null {
  const [kind, walletId, chain, token, hash, origin, ...rest] = noteId.split('|');
  if (kind !== NOTE || !walletId || !chain || !token || !hash || !origin || rest.length > 0)
    return null;
  const chainId = Number(chain);
  const slug = Number.isSafeInteger(chainId) ? alertSlug(chainId) : null;
  if (!slug || alertToken(chainId, token) !== token || !isNestySite(origin)) return null;
  return { page: `${origin}/#/token/${slug}/${token}`, walletId, origin };
}
