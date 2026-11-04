import { defineConfig } from 'wxt';
// Read here in Node, where import.meta.env is the process environment (WXT_STORE).
import { STORE_BUILD } from './src/shared/nesty-site';
import { API_HOSTS, BUILTIN_SITES } from './src/shared/sites';

/**
 * The Chrome Web Store item's public key (Package → View public key; not a secret). Every
 * other build carries it, so a local install has the store's ID,
 * edpbbibikoafckkmkcjhokffkghmklig, whatever folder it is loaded from. Chrome keeps an
 * extension's storage, the vault included, per ID. The store adds the key to its own build.
 */
const STORE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqpr/ihFwcOrgjORHNyhZ4V9XB21diVyu/UcGIZOp1y5QW7J5ZCHqy8ise6MHYrFKAp1JtIpCEAKol6f1fxIDQ2tGs3f9i8gXVWMVooY0cg4bBPWZcRJGzXfpeBs7F5wP7jhxseCGtUHtuowP4L2Gh0NHI1kYgB8v1QnThaAkq2VgIdbpENepBhueOI/+wD1Aj9P/I3uwm4zUKPEs0Iw6XhvGhEBSGSJjNoo4e3R5fiKI9qAWstZPKUZzyC2yAVBIpe6jLzZ7VoimvS+14c2DD+wwsgmR53tQYoaPixWVVEyGiEzFHpg019+HsQf5SfPqjWD63oZr5GUL8o5dIJE++wIDAQAB';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  manifestVersion: 3,
  // Explicit imports only: every dependency of security-sensitive code is visible.
  imports: false,
  manifest: {
    name: 'Nesty',
    ...(STORE_BUILD ? {} : { key: STORE_KEY }),
    // Also the store listing's summary (132 characters at most): docs/web-store.md.
    description:
      'Self-custody wallet with a one-click buy/sell panel on DEX trading sites, for EVM chains and Solana.',
    minimum_chrome_version: '116',
    // storage: vault + settings; alarms: auto-lock timer;
    // offscreen + clipboardWrite: blank the clipboard 30 s after a key export;
    // scripting + activeTab: inject the panel on sites the user enables at runtime;
    // notifications: the price alerts set on the Nesty website.
    permissions: [
      'storage',
      'alarms',
      'offscreen',
      'clipboardWrite',
      'scripting',
      'activeTab',
      'notifications',
    ],
    // Only the built-in terminals (and the pool-index API) are granted at install time.
    // Any other site is granted per-origin at runtime from the popup.
    host_permissions: [...BUILTIN_SITES.flatMap((s) => s.matches), ...API_HOSTS],
    optional_host_permissions: ['https://*/*'],
    web_accessible_resources: [
      {
        // The unlock field is an extension-origin iframe so the page cannot read keystrokes.
        resources: ['unlock.html'],
        matches: ['https://*/*'],
        use_dynamic_url: true,
      },
    ],
    content_security_policy: {
      // 'wasm-unsafe-eval' is required by hash-wasm (Argon2id). No remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  // JSX → Preact comes from tsconfig (jsx: react-jsx, jsxImportSource: preact).
  vite: () => ({
    build: {
      // Readable output makes reviewing the shipped bundle possible.
      minify: false,
      sourcemap: false,
    },
  }),
});
