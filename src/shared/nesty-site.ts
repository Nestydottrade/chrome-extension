/**
 * The Nesty website. There the extension shows no panel: it keeps the keys and signs the
 * trades the site builds, each checked again here first (route, limits, validator).
 */

/**
 * The hosted site, trusted by every build, and connected from the start until the user
 * disconnects it. www.nesty.trade only redirects here.
 */
export const HOSTED_SITE_ORIGINS: readonly string[] = ['https://nesty.trade'];

/**
 * The local development server: trusted by every build except the store's, and connected
 * only once the user approves it.
 */
const LOCAL_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * The build for the Chrome Web Store (`pnpm build:store`: scripts/store.mjs sets
 * WXT_STORE). It trusts the hosted site only, never a local server.
 */
export const STORE_BUILD = import.meta.env.WXT_STORE === 'true';

export const NESTY_SITE_ORIGINS: readonly string[] = STORE_BUILD
  ? HOSTED_SITE_ORIGINS
  : [...HOSTED_SITE_ORIGINS, ...LOCAL_ORIGINS];

/** Content-script matches for the Nesty website (match patterns take no port). */
export const NESTY_SITE_MATCHES: string[] = [
  ...new Set(NESTY_SITE_ORIGINS.map((o) => `${new URL(o).protocol}//${new URL(o).hostname}/*`)),
];

/** True when `origin` is the Nesty website's, exactly. */
export function isNestySite(origin: string): boolean {
  return NESTY_SITE_ORIGINS.includes(origin);
}
