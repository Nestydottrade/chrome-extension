/**
 * The Nesty website. There the extension shows no panel: it keeps the keys and signs the
 * trades the site builds, each checked again here first (route, limits, validator). Only
 * its local development server is listed; add the site's own origin once it is hosted.
 */

/** The local development server: trusted by every build except the store's. */
const LOCAL_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * The build for the Chrome Web Store (`pnpm build:store`: scripts/store.mjs sets
 * WXT_STORE). It trusts no local server, so until the site is hosted it has no Nesty
 * website at all: its content script is not built, and it asks for no notifications
 * permission, since only the site sets price alerts (see wxt.config.ts).
 */
export const STORE_BUILD = import.meta.env.WXT_STORE === 'true';

export const NESTY_SITE_ORIGINS: readonly string[] = STORE_BUILD ? [] : LOCAL_ORIGINS;

/** Content-script matches for the Nesty website (match patterns take no port). */
export const NESTY_SITE_MATCHES: string[] = [
  ...new Set(NESTY_SITE_ORIGINS.map((o) => `${new URL(o).protocol}//${new URL(o).hostname}/*`)),
];

/** True when `origin` is the Nesty website's, exactly. */
export function isNestySite(origin: string): boolean {
  return NESTY_SITE_ORIGINS.includes(origin);
}
