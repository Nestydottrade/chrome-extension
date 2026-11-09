# Nesty privacy policy

For the Nesty browser extension. Last updated 5 November 2026.

## What Nesty collects

Nothing. Nesty has no accounts and runs no analytics, tracking or crash reports, and the
extension sends none of your data to Nesty. It never sends anyone your keys, your recovery
phrases or your password.

## What stays on your device

The extension keeps these in your browser's storage, on this device only:

- your wallets, encrypted with your password (Argon2id and AES-256-GCM). While they are
  unlocked, the key that opens them is kept in the browser's memory for the session, and
  removed when they lock or the browser closes;
- your settings, among them any RPC addresses you entered;
- the sites you turned the panel on for;
- your activity: trades, bridges and transfers, with their amounts and transaction hashes;
- your take-profit and stop-loss plans, the price alerts you set on the Nesty website, and
  the wallets you follow there, with the trades Nesty read of them;
- copies of public data it read, such as token logos, to load faster next time.

Removing the extension deletes all of it. Nothing is kept anywhere else.

## Who sees what when you use Nesty

To read balances, find prices and send trades, the extension talks to outside services
directly from your browser. Each sees your IP address and what it is asked for:

- **Blockchain nodes (RPCs)** see the addresses Nesty reads, your wallets' among them, and
  the transactions you send. Every 30 seconds while you follow wallets, they also see those
  wallets' addresses and the transactions Nesty reads of them. In Settings you can set your
  own RPC for each chain, so public nodes no longer see your addresses.
- **A market data service** sees the tokens Nesty looks up, to find their pools and prices:
  among them, every 30 seconds while you have price alerts, the tokens they are for, and the
  tokens the wallets you follow trade.
- **A swap routing service**, asked only when no pool Nesty knows can trade a token, sees
  the tokens, the amount and the wallet that trades.
- **A bridge service**, when you bridge, sees the chains, the amount, and the sending and
  receiving addresses.
- **Image hosts** (the market data service's, and an IPFS gateway) see which token logos
  load. You can turn logos off in Settings.
- **Trading sites** where the panel runs: Nesty reads the page's address to find its token,
  and sends the site nothing.
- **The Nesty website** (nesty.trade), while the extension is connected to it (from the
  start, until you turn it off in the extension's popup), sees your wallets' names and
  public addresses, the trades, new coins, bridges and price alerts you make there, and
  the wallets you follow there with their trades. It never sees a key: the extension makes
  its trades, and checks and signs each transaction, itself. The site's own privacy policy is at
  https://nesty.trade/#/privacy.
- **X**, when you choose Post on X on a profit card, opens with the post's first words (the
  gain and the token) filled in. Nothing is posted until you post it.

Each of these services runs under its own privacy policy. Nesty sells nothing, and shares
nothing with them beyond these requests, all made over encrypted connections (HTTPS, or WSS
for a WebSocket RPC you set). The transactions you send are public on their blockchain, as
with any wallet.

Nesty's use of data follows the Chrome Web Store User Data Policy, including its Limited
Use requirements.

## Changes

When this policy changes, this file changes with it, and the date at the top says when.
