# Nesty

Chrome (Manifest V3) extension that holds your own wallets (EVM chains and Solana) and
injects a one-click buy/sell panel into DEX trading terminals. It reads the token from the page URL,
resolves it on-chain, routes across AMMs and bonding-curve launchpads, and signs
locally after a strict transaction validator.

> **Mainnet from day one.** There is no testnet stage. Start with a fresh wallet that
> holds a small amount. Defaults are conservative: $25 per transaction, $50 per click,
> confirmation above $20, simulation before every signature.

## What is supported

| Chain                  | AMMs                                                                | Launchpads                                                                        |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Ethereum (1)           | Uniswap v2 / v3 / v4, PancakeSwap v3                                | Clanker, Klik, Stockereum (v4 hook pools)                                         |
| Base (8453)            | Uniswap v2 / v3 / v4, PancakeSwap v3, Aerodrome (volatile + stable) | Flap curve, Clanker, Bankr (Doppler), Zora, Flaunch, Virtuals (curve + graduated) |
| BNB Smart Chain (56)   | Uniswap v2 / v3 / v4, PancakeSwap v2 / v3                           | four.meme, Flap curves                                                            |
| Robinhood Chain (4663) | Uniswap v3 / v4                                                     | Pons, Flap curves, Bankr (Doppler)                                                |
| Solana                 | PumpSwap, Raydium AMM v4 / CPMM, Meteora DAMM v2 / DLMM, Orca       | pump.fun (mayhem coins included), Meteora DBC, Raydium LaunchLab                  |

Tokens are routed against the chain's native asset (or its wrapped form), or against a
stablecoin (USDC, USDT, USD1, USDG, depending on the chain). A stablecoin pool is reached
in the same transaction: native → stable → token to buy, token → stable → native to sell,
both legs on the same DEX. For every amount Nesty quotes all pools it finds and uses the
best output. Curve tokens are routed to the launchpad while they are on the curve and to
the DEX after graduation.

**Sites.** Built in: GMGN, DEX Screener, DEXTools, GeckoTerminal, Birdeye, Axiom,
BasedBot, four.meme, Flap, pump.fun. Any other site: open it, then Nesty popup → Settings →
Sites → _Enable on this site_ (grants that one origin at runtime).

**Solana.** Each wallet from the recovery phrase also has a Solana address, derived the
way Phantom and Solflare do (`m/44'/501'/n'/0'`); imported keys are EVM only. The panel
trades pump.fun coins on their bonding curve and, once migrated, on their PumpSwap pool,
cashback and mayhem coins included. A coin paired with a token (USDC, or another pump
coin) is bought with what is at the bottom of its pairs, up to two hops, through
PumpSwap's multi-hop swap. When that is a token rather than SOL (USDC, an xStock such as
AAPLx), the coin is still bought and sold with SOL, as funded curves are on EVM chains:
in two transactions, SOL → token on the token's best SOL pool (from the index, and the
Orca fee-tier pools derived from the two mints; 1% slippage), then exactly the token that
arrived → coin. A sell runs the other way and swaps exactly the token the coin sold for;
if that second swap fails, the token stays in the wallet and the toast says so. A token
with no SOL pool is paid with directly. Coins elsewhere trade on their own pools: Raydium AMM v4 and
CPMM, Meteora DAMM v2 and DLMM, Orca Whirlpools, and the bonding curves of Meteora DBC
(Jupiter Studio, Bags, Believe and other launchpads built on it) and Raydium LaunchLab
(Bonk.fun). Their pools come from the DEX Screener index and from any pool the page
names; a coin with a Token-2022 transfer fee, or a transfer hook that runs a program, is
refused (the xStocks' hook runs none, so they trade). Quotes use the
programs' own fee math on the on-chain state and match what the programs pay, to the
unit, as the live tests check by simulating trades on mainnet. Not yet: Raydium CLMM,
Meteora's older dynamic AMM (DAMM v1), and pools whose price sits past the range Nesty
reads (a DLMM pool beyond its own bitmap, an Orca swap past three tick arrays) quote
nothing rather than a guess. Every transaction passes the Solana validator (only
Nesty's own instructions, accounts derived again from wallet and mint, the USD and
priority-fee limits) and, with simulation on, is simulated before signing. The priority
fee is set in SOL per transaction (Settings → Chains → Solana). Send, Distribute,
Collect, Bridge and exit plans work on Solana too; claiming pump.fun cashback does not
yet. The built-in RPC (publicnode) refuses wallet-wide token reads, so the popup lists
the Solana tokens you traded or added by mint; with your own RPC it also finds tokens
sent to your wallets.

## Install and first use

```bash
pnpm install
```

```bash
pnpm build
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   `.output/chrome-mv3`.
2. The setup tab opens. Create a wallet (write down the 12 words, confirm 3 of them) or
   import a recovery phrase.
3. Fund _Wallet 1_ with a small amount on the chain you want to try.
4. Open a token page on a supported site. The panel appears on the right.
5. Unlock inside the panel (the password field is an extension frame the page cannot
   read), then click a quick-buy button. Hotkeys: `1`–`4` buy, `Q` `W` `E` `R` sell
   25/50/75/100 %.

In the panel, under the quick-buy buttons: slippage (10 / 20 / 40 % or custom), priority
fee (Low / Medium / High or custom gwei; hidden on first-come-first-served chains) and MEV
protection. The pencil next to "Buy" edits the four quick-buy amounts, the one next to
"Sell" the four quick-sell percentages (hotkeys Q W E R follow them). All of these are saved
per chain. While a position is up, "Initials" next to "Sell" sells the share of it that is
worth what its tokens cost; the website's trade panel has the same button.

The position's PnL figure opens it as a card to share: a picture (1200 × 675, drawn at twice
that) with the percentage and what it came to, the prices it traded at, the market cap and
how long it was held, its amounts in what paid for it, in dollars, or left out. From the
panel or the popup's open-PnL line it opens in a small Nesty window, to copy, save or post
on X. On the website a dialog opens from the position, from Portfolio's and Activity's
Profit figures, and from the notice of a finished sell.

### Popup

Four tabs along the bottom:

- **Wallets.** Wallet pills (All, W1★, W2, …) at the top, the total in USD, then the
  tokens you hold on the selected chain with their logos. Tokens worth under $1 (or with
  no price) are folded into a "dust" row. Tap a token for _Open chart_, _Sell 50 %_ and
  _Sell 100 %_. Below: New, Import, Distribute, Collect.
- **Activity.** Every trade, transfer and bridge Nesty sent (last 200), grouped by day,
  filterable, each with its transactions and explorer links. The tab badge counts
  pending ones.
- **Bridge.** Native → native between Nesty's chains, Solana included, through
  [Relay](https://relay.link): quote as you type, MAX keeps gas back, live status until
  the funds arrive. It pays one of your wallets, or another address typed in, checked as
  a Send's: refused where funds are lost (a token contract, a Solana program, mint or
  token account), shown in full before it goes, and the password above the confirmation
  amount.
- **Settings.** Safety limits, confirmation threshold, simulation, auto-lock, password
  change, multi-wallet mode, jitter and buy variance (each wallet buys up to a set share
  less, at random, never more), hotkeys, logos; per chain: quick-buy amounts, default
  slippage, Low/Medium/High priority fees, max-fee multiplier, custom RPC, WebSocket RPC,
  MEV private RPC (Ethereum and BSC only).

**Which tokens show up.** Tokens you traded or transferred with Nesty, tokens you add
with _Add token_, and tokens found by scanning `Transfer` logs to your wallets. Public
RPCs refuse that scan (Nesty then retries after an hour), so a token bought outside Nesty
only appears automatically with a custom RPC; otherwise add it once by address.

**WebSocket RPC (optional).** With a `wss://` URL set, Nesty subscribes to new blocks:
confirmations are noticed in the block they land, and the panel's quotes and fee
estimates refresh every block. Quotes and sending still go over HTTPS, which also takes
over if the socket drops. The status line under the field shows the connection.

### The Nesty website

On the Nesty website the extension shows no panel and only keeps the keys. The site
finds coins, quotes, builds and sends its own trades with Nesty's code (Solana, and the
EVM engine with its venues, gas and nonce handling), and asks the extension to sign each
one. On every other site the extension works as described above.

- The site is recognised by its exact origin, listed in `src/shared/nesty-site.ts`:
  `https://nesty.trade` in every build, and the local development server
  (`http://localhost:5173`) in every build but the store's (`pnpm build:store`). A
  content script on those origins carries window messages to the background and does
  nothing else.
- What the site may ask for: whether Nesty is there (with the user's limits), a
  connection (`https://nesty.trade` has one from the start, until the user disconnects
  it; the development server, or the site after a disconnect, gets one once the user
  approves it in an extension window), the wallets' names and public addresses, the
  unlock window, a signature on a trade or on a new coin
  (`site.sol.sign`, `site.evm.sign`, `site.evm.permit`), a bridge
  (`site.bridge.quote`, `site.bridge.send`, `site.bridge.status`), and price alerts
  (`site.alerts.list`, `site.alerts.set`, `site.alerts.remove`), which the extension
  keeps and checks every 30 seconds, with a notification when one is reached. It may also
  follow wallets (`site.tracker.feed`, `site.tracker.follow`, `site.tracker.unfollow`,
  `site.tracker.edit`, `site.tracker.prefs`): at most 20 per site, read from the chain
  every 30 seconds while the browser runs, Solana by signatures and EVM chains by balance
  and sent count, with a notification (Open coin, Mute) for each new trade. It can
  never read a key, export one, change settings, or get anything else signed: no
  transfers or revokes.
- Every Solana trade it sends is checked as the panel's are: the route is read again
  from the chain, the Solana validator runs with the user's limits, and the minimum
  received must be at least half of what Nesty's own quote pays. A coin quoted in a
  token is two signatures, as in the panel: SOL → token on a SOL pool the extension finds
  itself, then token → coin, whose spend is valued in SOL against the per-transaction
  limit. Both count toward the per-minute limit, as the two EVM transactions of a funded
  curve do.
- An EVM transaction comes with how it was built: a swap or Nesty Router call on a
  named pool, an approval, or a speed-up or cancel. The extension finds the pool again
  itself, builds the same call with the venue's own encoder and requires it to match
  exactly (target, calldata, value), then runs the validator with the user's limits.
  The minimum received must be at least half of its own quote, the expected gas fee
  within the gas limit, and the native coin's price known. Approvals may only cover the
  traded token or the asset its pool is priced in, for that pool's own spender or
  Permit2, bounded unless unlimited approvals are on;
  Permit2 permits only for what the wallet holds; a speed-up only for a transaction it
  signed itself; a cancel only as an empty transfer to the wallet. Aggregator routes are
  never signed for the site, since their calldata comes from an outside API.
- A new coin from the site's Create page comes as its details (name, ticker, image and
  metadata addresses, tax, salt, dev buy), on the launchpads Nesty trades that take a
  coin straight from a wallet: Flap (BSC, Base, Robinhood), Clanker (Base, Ethereum),
  Klik (Ethereum), Pons (Robinhood) and pump.fun. The extension builds the launchpad's
  call from those details for the signing wallet (`src/background/create/`) and
  requires the site's to match exactly: every fee, reward and dev-bought token goes to
  that wallet, Flap's interface commission to no one, and Pons gets exactly its current
  launch fee. The details are held to the launchpad's own limits (bytes, as the
  contracts count them; no hidden characters; https or IPFS addresses only; only the
  taxes it offers), the dev buy to the per-transaction limit and the gas to the gas
  limit. A pump.fun coin is two signatures on one transaction: the mint key the site
  made for it, and the wallet's, given after the extension has rebuilt `create_v2` and
  the dev buy and run the Solana validator on them. Every new coin waits for the user in
  an extension window that shows the coin, its launchpad and what it spends.
- A buy above the confirmation amount, or past the per-click limit within one minute,
  waits for the user in an extension window. Only the signature goes back, and the site
  checks it against the wallet's address before sending.
- A bridge is the one thing the site does not build: it names the chains, the amount,
  the sending wallet and who is paid (one of the user's wallets, or an address), and the
  extension quotes, checks, signs and sends it as the popup's Bridge does. To the user's
  own wallet it waits for them as a buy does, and counts toward the same per-minute
  limit; to any other address it always waits, in an extension window that shows the
  address in full and asks the password above the confirmation amount. The site follows
  only the bridges it started.
- Trades made on the site are kept in that site's storage in the browser, not in the
  extension's Activity.

The website itself is not tracked in this repository.

## Architecture

```
 Trading terminal tab
 ┌────────────────────────────────────────────────────────────────────┐
 │ page JS (untrusted)   ╳ cannot reach the panel (closed shadow root, │
 │                         isTrusted checks on clicks and keys)        │
 │ ┌──────────── content script (isolated world) ───────────────────┐  │
 │ │ URL adapter → Detection { chain?, token | pair | v4 pool id }  │  │
 │ │ Panel (Preact) · iframe: unlock.html (extension origin)        │  │
 │ │ no keys, no signing                                            │  │
 │ └────────────────────────────┬───────────────────────────────────┘  │
 └──────────────────────────────┼──────────────────────────────────────┘
                                │ runtime messages: zod-parsed, sender id +
                                │ origin + top frame checked, per-sender allowlist
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │ background service worker — the only place keys exist               │
 │  resolve (on-chain) → routing (venues) → engine:                    │
 │    quote → build → VALIDATOR → simulate → sign → nonce → send → watch│
 │  vault: Argon2id → AES-256-GCM (storage.local = ciphertext only)    │
 │         AES key in storage.session (trusted contexts only)          │
 └──────────────────────────────▲──────────────────────────────────────┘
                                │
 ┌──────────────────────────────┴──────────────────────────────────────┐
 │ popup: wallets + holdings, activity, bridge (Relay), settings        │
 └─────────────────────────────────────────────────────────────────────┘
```

### A buy, step by step

1. The adapter reads `gmgn.ai/base/token/0x…` → `{ chainId: 8453, token }`. Pair URLs
   (DEX Screener, DEXTools, GeckoTerminal) are resolved via `token0/token1`; v4 pool ids
   via Uniswap's PositionManager (re-hashed to verify). Nothing is read from the DOM.
2. The background reads name/symbol/decimals on-chain (sanitised) and discovers pools:
   Uniswap v2/v3/v4 (standard tiers, Zora `getPoolKey()`, and the DEX Screener index
   verified on-chain), PancakeSwap, Aerodrome, four.meme / Flap / Pons curves.
3. Quotes for all quick amounts plus a tiny reference amount are fetched in one round
   trip per pool; price impact is measured against the reference on the same pool.
4. On click: USD limits and the confirmation threshold are checked (USD price comes
   from native → stablecoin liquidity on-chain), the chosen pool is re-quoted, minimum
   output = quote × (1 − preset slippage).
5. The transaction is built, **validated**, simulated (`eth_estimateGas`), signed with
   EIP-1559 fees from the preset (priority fee ignored on Arbitrum-stack chains), given
   a locally tracked nonce and sent (private RPC when MEV protection is on).
6. An approval follows so the next sell is one click (Permit2 for Uniswap; the
   router/curve itself for the others). By default it is unlimited and sent once per
   token; with "Approve each token once" off it is bounded and topped up after each buy. Sells through Uniswap sign a Permit2 permit for
   exactly the amount sold.

| Path                                   | What                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `src/content/adapters.ts`              | URL adapters (add a site here)                            |
| `src/content/panel/`                   | Panel UI, hotkeys, drag, toasts                           |
| `src/background/resolve.ts`            | On-chain token resolution                                 |
| `src/background/trade/uniswap/`        | Universal Router codec + Uniswap venue + addresses        |
| `src/background/trade/venues/`         | Generic v2-router and v3-router venues                    |
| `src/background/trade/venues.ts`       | PancakeSwap / Aerodrome instances (add an AMM here)       |
| `src/background/trade/launchpads.ts`   | four.meme, Flap, Pons curves                              |
| `src/background/trade/legs.ts`         | Native ↔ quote-asset pools for curves quoted in an ERC-20 |
| `src/background/trade/nesty-router.ts` | Nesty Router steps, encoding, Permit2 transfer, rule      |
| `src/background/trade/validator.ts`    | Pre-signature validator                                   |
| `src/background/trade/engine/`         | Engine: core (validate, sign, send, receipts) + flows     |
| `src/background/panel.ts`              | Panel state and live quotes                               |
| `src/background/vault/`                | Key storage                                               |
| `src/shared/chains/definitions.ts`     | Chain config (add a chain here)                           |
| `src/background/solana/`               | Solana: keys, RPC, pump.fun / PumpSwap, validator, trades |
| `src/background/solana/dex/`           | Solana pool programs: one module each (add a DEX here)    |
| `src/background/site.ts`               | The Nesty website: connection, approvals, trade signing   |
| `src/background/trade/site-evm.ts`     | Rebuilds and checks the site's EVM transactions           |
| `src/background/create/`               | A new coin's transaction on each launchpad                |
| `src/shared/create.ts`                 | Each launchpad's limits and taxes for a new coin          |
| `src/background/trade/signer.ts`       | EVM signer interface: the vault's, or the site's request  |
| `src/shared/nesty-site.ts`             | The Nesty website's origins (add the hosted one here)     |

### Adding things

- **Chain:** one entry in `src/shared/chains/definitions.ts` (schema-validated at load)
  plus its Uniswap addresses in `src/background/trade/uniswap/addresses.ts`. Arbitrum One
  was added exactly this way, with no code changes. It is archived for now: its entry stays
  but is left out of `CHAIN_DEFINITIONS`, and putting it back in that list restores it.
- **AMM:** one `v2RouterVenue(...)` / `v3RouterVenue(...)` entry in `venues.ts`.
- **Launchpad:** a `Venue` with `discover` (only while on the curve), `quote`, `build*`,
  `sellApproval` and `poolRules` (validator rule for its contract).
- **Site:** an adapter in `adapters.ts`, and its match pattern in `src/shared/sites.ts`.

## Transaction validator

Runs before every signature (transactions and Permit2 typed data), synchronously,
without RPC; well under 5 ms (tested). Anything not understood is rejected and shown in
the panel as _Transaction blocked_ with each decoded action.

- Sender must be one of your wallets; native value ≤ per-transaction USD limit.
- Allowed targets: the chain's Universal Router, the traded token, allowlisted AMM
  routers / launchpad contracts, and your own wallets (plain transfers only).
- Universal Router: only `WRAP_ETH`, `UNWRAP_WETH`, `SWEEP`, `V2/V3_SWAP_EXACT_IN`,
  `V4_SWAP` (swap-exact-in-single, settle, settle-all, take, take-all) and
  `PERMIT2_PERMIT`; the allow-revert flag is rejected. Assets limited to the traded
  token, native, wrapped native and the chain's listed stablecoins; a stablecoin may only
  sit between native and the token, and any stablecoin a step leaves in the router must
  be used up by a later step (whole balance swapped on, or swept to you). Every output
  recipient must be the router itself or your wallet, and at least one step must pay you.
  Non-zero minimum output required. Deadline within 30 minutes.
- Permit2 permits: the traded token, spender = router, amount ≤ the amount being sold,
  expiry ≤ 2 hours.
- ERC-20: `approve` only to Permit2 or an allowlisted router/curve, and never above the
  amount the engine asked for (unlimited only when that setting is on); `transfer` only
  to your wallets; everything else rejected.
- Router/launchpad rules: direct swap or one stablecoin hop (native on one end, the
  traded token on the other), own recipient, slippage, deadline, value checks.
- Nesty Router (only where a chain has `nestyRouter` set): `execute` must buy the
  traded token with native, or sell it for native through a Permit2 transfer of at most
  the amount sold to this router; every asset the route touches is returned to you.
  Each step is decoded: the Universal Router and venue rules above apply to it as if
  the router were your wallet; a step's `spender` (allowed to pull its amount for that
  call only) must be an allowlisted venue; token steps may only hand the router's exact
  balance to the next step's contract, never approve; Permit2 and the router itself are
  never targets; injected amounts must sit inside the call.

Tests: every legitimate plan from every venue passes; 19 named malicious payloads and a
2,000-case fuzz run never let value or tokens reach a foreign address.

## Threat model

| Threat                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page reads keys or password                  | Keys only in the background. No message returns key material to content scripts. `storage.session` and `storage.local` (encrypted vault, RPC URLs, history) restricted to trusted contexts; the panel keeps its position through the background. Unlock is an extension-origin iframe.                                                                                                     |
| Page drives the panel                        | Closed shadow root; clicks and hotkeys require `isTrusted`; hotkeys ignored while typing anywhere.                                                                                                                                                                                                                                                                                         |
| Page fakes the token (UI says A, URL says B) | The panel shows the on-chain symbol and the contract address with an explorer link; validator restricts every trade to that address.                                                                                                                                                                                                                                                       |
| Forged messages                              | zod schema per message; `sender.id`, top frame, https origin allowlist; content scripts limited to panel/trade requests (no unlock, no export, no settings).                                                                                                                                                                                                                               |
| Malicious token metadata                     | Labels stripped of control/bidi/zero-width characters and capped; rendered as text only (ESLint bans `innerHTML` & co.).                                                                                                                                                                                                                                                                   |
| Bad calldata (bug or tampering)              | Validator above; simulation before signing (default on).                                                                                                                                                                                                                                                                                                                                   |
| Sandwich attacks (Ethereum, BSC)             | Sends go through a private RPC by default (Flashbots Protect, PancakeSwap MEV Guard); the panel shows "MEV: unprotected" whenever they would reach the public mempool.                                                                                                                                                                                                                     |
| Fee mistakes and spikes                      | Gas is outside the USD trade limits, so the expected fee (simulated gas × base fee + tip) is checked against a separate gas limit (default $10) before anything is signed.                                                                                                                                                                                                                 |
| Unlimited approvals                          | Spender limited to Permit2 or allowlisted routers/curves. Unlimited by default (one approval per token, for speed); can be switched to holdings × (1 + headroom). Permit2 permits exactly per sell.                                                                                                                                                                                        |
| Lost/stolen device, idle browser             | Argon2id (~500 ms, params bound in AES-GCM AAD); a new wallet's password needs 12+ characters with an uppercase letter, a lowercase letter, a number and a symbol; auto-lock; lock on browser close; unlock throttling.                                                                                                                                                                    |
| Exported key lingering                       | Export only in the popup, password re-entry, clipboard blanked after 30 s by an offscreen document.                                                                                                                                                                                                                                                                                        |
| Telemetry / logs                             | None. `no-console` is an ESLint error.                                                                                                                                                                                                                                                                                                                                                     |
| Supply chain                                 | Exact-pinned deps, pnpm minimum release age respected, unminified build, MV3 CSP without remote code (`wasm-unsafe-eval` only for Argon2id).                                                                                                                                                                                                                                               |
| Privacy                                      | The DEX Screener pool index sees token lookups; its image CDN, and pump.fun's IPFS gateway for Solana coins, see which logos you load (both toggles in Settings). Public RPCs see your addresses; use your own RPC to avoid that.                                                                                                                                                          |
| Malicious logo images                        | Fetched by the background only, PNG/JPEG/WebP/GIF only (no SVG), ≤ 200 KB, must decode as an image, shown as a `data:` URL in an `<img>`. Of a coin's IPFS metadata only the CIDs are used, always through the one gateway.                                                                                                                                                                |
| Bridge (Relay) returns a bad transaction     | Only Relay's depository contract (same address on all chains) and only `depositNative(depositor, id)` are accepted; depositor must be you, value must equal your amount, the quoted recipient must be the wallet or address you chose. From Solana: only `deposit_native` to Relay's depository program, credited to the sending wallet, for your amount. Then the normal validator and simulation run. |

**The Nesty website.** Unlike a terminal page, it can ask for trades without a click
in Nesty's own UI, so a compromised copy of it could buy coins the user did not choose.
What it can get is bounded: only from its exact origin, only while it is connected (from
the start, until the user disconnects it), only trades between the wallet's own funds and
a coin, or a new coin whose every fee and
reward goes to the wallet, or a bridge the extension builds itself, each rebuilt or
re-checked from the chain by the extension, validated as above and held to the same
limits. A buy above the confirmation amount, or past the per-click limit within a
minute, waits for the user in an extension window, as every new coin and every bridge
to an address outside their wallets does.

**Residual risks.** A page can overlay its own UI to trick you into clicking the
panel (clickjacking); limits cap the damage. Pool-derived USD prices could be skewed in
very thin markets. Receipt tracking stops if the browser closes; check the explorer.

## Known limitations

- KyberSwap (every EVM chain) is quoted alongside Nesty's own routes and used when no
  listed pool can trade a token (other quote tokens, tokenised stocks, unlisted DEXes) or
  when it pays at least 0.5% more. In the second case its buy is first simulated: if it
  delivers less than Nesty's own pool would (the API can misjudge a pool on its route),
  KyberSwap is dropped for that token for 10 minutes. Token tax is always measured on
  Nesty's own pools, never on a KyberSwap route. Its swap description is decoded and checked (output to
  your wallet, a minimum, no extra fees, no embedded permits), sells approve exactly the
  amount sold, and it adds one API round trip at click time. It can be turned off in
  Settings; holdings are never valued through it. Both legs of a stablecoin route use the same DEX, so a token
  whose only stable pool is on a DEX without a native/stable pool there is not reached.
  On Uniswap the native/stable leg is a v3 pool.
- Curves quoted in an ERC-20 the launchpad cannot buy with native (Virtuals in VIRTUAL,
  Flap curves without native swap such as PEPE quotes, Pons curves in USDG) are funded
  through the best native ↔ asset pool. Until the Nesty Router (`contracts/`) is
  audited and deployed on a chain, a buy is three transactions (native → asset,
  approval once, curve buy) and a sell ends with asset → native; with it, each is one
  transaction. four.meme tokens quoted in BEP-20 use four.meme's own helper and are
  always one transaction. Flaunch coins (paired with flETH) are one transaction through
  Uniswap v4.
- Not yet supported: Trench (unverified contracts), Printr, Livo, long.xyz pools before migration,
  o1.exchange, stonks, Pools.trade auctions, Aerodrome Slipstream, PancakeSwap Infinity,
  other Robinhood DEXes (Metric, Ramses, …).
- Tax tokens: quotes ignore the tax; raise slippage (20 % or 40 % in the panel) for them. Universal Router
  v3/v4 paths may fail for fee-on-transfer tokens; PancakeSwap v2 / Aerodrome handle them.
- Speed-up / cancel only for transactions sent in the current browser session.
- Bridge: native assets only. Delivery on the destination chain is done by Relay's
  solver; Nesty can check the deposit, not the fill, so you trust Relay for that leg
  (its status is tracked, and Relay refunds failed fills).
- Token logos load for tokens DEX Screener has an image for, and for Solana coins whose
  metadata is on IPFS (coins launched on pump.fun); others get a letter.
- A bridge to a Solana wallet that does not exist yet must deliver at least a wallet's
  rent-exempt minimum (read from the chain); Nesty refuses smaller amounts.

## Development

| Command            | What                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`       | typecheck, lint, unit tests, production build                                                                                                                                                                                        |
| `pnpm test`        | unit tests (vault, validator incl. fuzz, adapters, codec helpers, fees, nonces, format)                                                                                                                                              |
| `pnpm test:live`   | read-only mainnet tests: token resolution, and buy → approve → sell simulations via `eth_simulateV1` for every venue and launchpad on every chain, with a throwaway key and a fake balance (no funds)                                |
| `pnpm dev`         | WXT dev mode with reload                                                                                                                                                                                                             |
| `pnpm build:store` | the build for the Chrome Web Store, in `.output/chrome-mv3-store`: the production build without the local Nesty website (no content script for it, no notifications permission); fails if the output still mentions the local server |
| `pnpm zip:store`   | the same, zipped for upload: `.output/nesty-<version>-chrome-store.zip`                                                                                                                                                              |

For the store listing: [docs/web-store.md](docs/web-store.md) (texts, permission reasons,
images) and the privacy policy, [PRIVACY.md](PRIVACY.md).

## Dependencies

| Package                                                                               | Why                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `wxt` (dev)                                                                           | MV3 build: entrypoints, manifest, Vite                           |
| `preact`, `@preact/signals`                                                           | Small UI runtime                                                 |
| `viem`                                                                                | ABI encode/decode, RPC, signing, HD keys                         |
| `@scure/bip39`                                                                        | Mnemonic validation and seed derivation (same version viem uses) |
| `@noble/curves`, `@noble/hashes`, `@scure/base`                                       | Solana: ed25519 keys and signatures, SLIP-0010, base58           |
| `hash-wasm`                                                                           | Argon2id                                                         |
| `zod`                                                                                 | Runtime validation of messages, config and storage               |
| `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `vitest` (dev) | Tooling                                                          |

Out of scope: limit and DCA orders.
