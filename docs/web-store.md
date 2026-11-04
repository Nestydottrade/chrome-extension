# Chrome Web Store

Everything the listing asks for, ready to paste, and the steps that need the developer
account. Upload `pnpm zip:store`'s zip, never the normal build's.

## The package

- `pnpm zip:store` builds `.output/chrome-mv3-store` and zips it to
  `.output/nesty-<version>-chrome-store.zip`. It is the production build trusting the
  Nesty website (`https://nesty.trade`) and no local server. The script fails, and
  leaves no zip, if the output still mentions the local server, or asks for
  notifications without the website.
- The version comes from `package.json`. Each upload needs a higher one.
- No remote code. The bundle is not minified and has no source maps, so a reviewer can
  read it. The content security policy allows the extension's own scripts only, plus
  WebAssembly for Argon2id (`hash-wasm`, bundled).

## Store listing

**Name:** Nesty

**Summary:** the manifest's `description` (in `wxt.config.ts`; 132 characters at most):

> Self-custody wallet with a one-click buy/sell panel on DEX trading sites, for EVM chains
> and Solana.

**Category:** Tools. **Language:** English.

**Homepage URL:** `https://nesty.trade`. **Support URL:**
`https://github.com/Nestydottrade/chrome-extension/issues`. Leave the official URL empty:
it needs the domain verified in Google Search Console.

**Description:** plain text; the store keeps line breaks. The trading sites are three
examples on purpose: long lists of other products' names risk being read as keyword spam.

```text
Nesty is a wallet you hold yourself, with a buy/sell panel on the sites where you find tokens.

Open a token on a trading site such as GMGN, DEX Screener or pump.fun, and Nesty's panel appears on the page. Buy or sell in one click, with the amounts you set. Nesty reads the token from the page's address, finds its pools, quotes each one on-chain and takes the best. A token still on its launchpad curve trades on the curve; once it graduates, on the DEX. You can turn the panel on for any other site from Nesty's popup.

On the Nesty website, nesty.trade, you can follow new launches live, chart tokens, create a coin, bridge and set price alerts, trading with the wallets in Nesty: the site builds each trade, and Nesty checks it against your limits and signs it. Your keys never leave the extension.

Chains: Ethereum, Base, BNB Smart Chain, Robinhood Chain and Solana.

In the wallet:
• EVM and Solana wallets: make new ones or import your own
• Balances, tokens and activity
• Send, and bridge between chains, to your own wallet or another address
• Take profit and stop loss
• Profit and loss per token, with a card to share it

Safety:
• Your wallets are encrypted with your password (Argon2id and AES-256-GCM) and never leave your device.
• Limits on every trade, to start: $25 per transaction, $50 per click, a confirmation above $20, and a cap on the network fee. Change them in Settings.
• Every transaction is checked by a strict validator and, unless you turn it off, simulated before it is signed.
• You type your password into Nesty's own page, so a site cannot read it.
• Nesty locks itself after 15 minutes without use (you choose how long), and when the browser closes.
• No accounts, no analytics, no tracking.

Trading tokens is risky: prices can fall to zero. Start with a fresh wallet that holds a small amount.
```

**Images:** in `design/store/` (see [Images](#images)).

## Privacy practices

**Single purpose:**

```text
Nesty is a self-custody crypto wallet for trading tokens: it keeps the user's wallets encrypted on their device, adds a buy/sell panel to DEX trading sites so they can trade the token they are looking at, and signs the trades they make on the Nesty website.
```

**Permissions** (one field each):

| Permission                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                              | Keeps the user's encrypted wallets, settings, activity, take-profit and stop-loss plans, and the sites they turned the panel on for, on their device. While the wallet is unlocked, session storage holds the key that decrypts it, so it is gone when the browser closes.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `alarms`                               | Locks the wallet after the auto-lock time, and wakes the extension every 30 seconds to check the user's take-profit and stop-loss plans and price alerts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `offscreen`                            | Opens an offscreen document (reason CLIPBOARD) that blanks the clipboard 30 seconds after the user copies a private key or recovery phrase, so the secret does not stay there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `clipboardWrite`                       | Lets that offscreen document blank the clipboard, which happens without a click.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripting`                            | Adds the panel to a site that is not built in, only after the user turns it on for that site in the popup and Chrome grants that site's permission: registers the panel's content script there and injects it into the open tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `activeTab`                            | Lets the popup read the address of the tab the user is on, to offer turning the panel on for that site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `notifications`                        | Shows a notification when a price alert the user set on the Nesty website is reached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Host permissions                       | The ten built-in trading sites (gmgn.ai, dexscreener.com, www.dextools.io, www.geckoterminal.com, birdeye.so, axiom.trade, basedbot.app, four.meme, flap.sh, pump.fun), where the panel shows. The Nesty website (nesty.trade), where a content script carries the site's requests to the extension, which signs the user's trades there once they connect it. The services the extension reads from: the DEX Screener API and image CDN (pools, prices, logos), the KyberSwap aggregator API (a route when no known pool trades a token), the Relay API (bridge quotes and status), and the public RPC endpoints of the supported chains (balances, quotes, sending transactions). |
| Optional host permission `https://*/*` | Asked for one site at a time, only when the user turns the panel on for a site that is not built in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Not a permission, but a reviewer may ask: `unlock.html` is web-accessible (dynamic URL)
because the panel's unlock field is that extension page in an iframe, so the trading site
cannot read the password.

**Remote code:** No.

**Data usage.** What the extension handles, for ticking the boxes (facts, not legal
advice):

| Data                                       | Where it goes                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password, private keys, recovery phrases   | Nowhere: the password unlocks the vault on the device and is never stored; keys stay encrypted on the device.                                                       |
| Wallet addresses, balances, transactions   | To blockchain nodes (RPCs), to read balances and send the transactions the user signs; for a bridge, to the bridge service; for a fallback route, to the route API. |
| Wallet names and public addresses          | To the Nesty website, once the user connects the extension there.                                                                                                   |
| Tokens looked up                           | To the market data API and its image CDN.                                                                                                                           |
| Price alerts                               | Stay on the device; their tokens' prices are read from the market data API every 30 seconds.                                                                        |
| Page address on trading sites              | Read on the device to find the token; never sent.                                                                                                                   |
| Activity, settings, plans, sites turned on | Stay on the device.                                                                                                                                                 |

Nothing goes to Nesty: no account, analytics or tracking. The Nesty website is static
files, so what it learns from the extension stays in the user's browser. Suggested:
tick **Financial and payment information** (transactions, sent to blockchain nodes to
carry them out) and, if the form counts data that never leaves the device,
**Authentication information** (the password). Then the three certifications: Nesty sells
no data, uses it only for its single purpose, and not for creditworthiness or lending.

**Privacy policy URL:** `https://github.com/Nestydottrade/chrome-extension/blob/main/PRIVACY.md`.
A change shows there once it is pushed to `main`. The website's privacy page,
`https://nesty.trade/#/privacy`, could be the URL instead; keep both texts saying the same.

## Images

In `design/store/`, from the extension's own pages: the store build, run with sample data
(a fresh wallet with no funds, a sample balance, a real token's live quotes).

| File                      | Size       | Store field                     |
| ------------------------- | ---------- | ------------------------------- |
| `screenshot-1-panel.png`  | 1280 × 800 | Screenshot (the first is shown) |
| `screenshot-2-wallet.png` | 1280 × 800 | Screenshot                      |
| `screenshot-3-limits.png` | 1280 × 800 | Screenshot                      |
| `small-tile-440x280.png`  | 440 × 280  | Small promo tile                |
| `marquee-1400x560.png`    | 1400 × 560 | Marquee promo tile              |

The store icon is `public/icon/128.png` (it keeps the store's 16 px transparent margin).

## With the developer account

1. Register a developer account (one-time fee) and verify its contact email.
2. Upload the zip as a new item and save it as a draft: do not submit yet.
3. Package → View public key. It is `STORE_KEY` in `wxt.config.ts`, in the manifest of every
   build but the store's (the store adds its own), so a local build has the store's
   extension ID: `edpbbibikoafckkmkcjhokffkghmklig`.
4. Fill in the listing and the privacy practices from this page, and pick the visibility:
   Public, or Unlisted (only people with the link find it).
5. Submit for review.
