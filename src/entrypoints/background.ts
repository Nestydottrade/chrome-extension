import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { browser } from 'wxt/browser';
import { ExitWatcher } from '../background/exits';
import { AlertWatcher } from '../background/alerts';
import { TrackerWatcher } from '../background/tracker';
import { trackNote } from '../background/tracker-notes';
import { evmReader, solReader } from '../background/tracker-reads';
import { defineBackground } from 'wxt/utils/define-background';
import { ClientPool, toViemChain } from '../background/chain/client';
import { handleMessage, type RouterDeps, type SiteControl } from '../background/router';
import { classifySender } from '../background/sender';
import { SiteService } from '../background/site';
import { SettingsStore } from '../background/settings';
import { SolanaService } from '../background/solana/service';
import { broadcastRaw } from '../background/trade/broadcast';
import { AggregatorCheck } from '../background/trade/aggregator-check';
import { TradeEngine } from '../background/trade/engine';
import { FeeCache } from '../background/trade/fees';
import { kyberVenue } from '../background/trade/kyber';
import { TaxService } from '../background/trade/tax';
import { launchpadRules, launchpadVenues } from '../background/trade/launchpads';
import { NonceManager } from '../background/trade/nonce';
import { PriceService } from '../background/trade/prices';
import { Routing } from '../background/trade/routing';
import { SiteEvmChecker } from '../background/trade/site-evm';
import { uniswapVenue } from '../background/trade/uniswap/venue';
import { extraVenues, venueRules } from '../background/trade/venues';
import { Vault, type KeyValueStore } from '../background/vault/vault';
import { HistoryStore, reachedChain } from '../background/history';
import { LogoService } from '../background/logos';
import { panelQuotes } from '../background/panel';
import { PortfolioService } from '../background/portfolio';
import { createRelayClient } from '../background/trade/relay';
import { WsHub } from '../background/ws';
import { CHAINS } from '../shared/chains';
import { getChain, type ChainConfig } from '../shared/chains';
import type { PushEvent } from '../shared/messages';
import type { TradeTicket } from '../shared/panel';
import { SHARE_KEY, type PnlCard } from '../shared/pnl-card';
import type { ChainSettings } from '../shared/settings/defaults';
import { HOSTED_SITE_ORIGINS, isNestySite } from '../shared/nesty-site';
import { ALERT_CHECK_MINUTES, alertPage } from '../shared/alerts';
import { isSolana } from '../shared/solana';
import { TRACK_CHECK_MINUTES } from '../shared/tracker';
import { isBuiltinOrigin, siteScriptId } from '../shared/sites';

const AUTOLOCK_ALARM = 'nesty.autolock';
const EXITS_ALARM = 'nesty.exits';
const ALERTS_ALARM = 'nesty.alerts';
const TRACKER_ALARM = 'nesty.tracker';
const OFFSCREEN_PATH = '/offscreen.html';
const CLIPBOARD_CLEAR_MS = 30_000;
/** Minimum gap between connection keep-alive pings per chain. */
const RPC_WARM_MS = 15_000;
const CONTENT_SCRIPT = '/content-scripts/content.js' as const;

function area(storage: typeof browser.storage.local): KeyValueStore {
  return {
    get: async (key) => (await storage.get(key))[key],
    set: (key, value) => storage.set({ [key]: value }),
    remove: (key) => storage.remove(key),
    getAll: () => storage.get(null),
  };
}

/** KyberSwap aggregator API (fallback routes). Asks for a JSON answer within 6 s. */
const aggregator = {
  get: (url: string) => fetchJson(url, { headers: { 'x-client-id': 'nesty' } }),
  post: (url: string, body: unknown) =>
    fetchJson(url, {
      method: 'POST',
      headers: { 'x-client-id': 'nesty', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(t);
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export default defineBackground({
  type: 'module',
  main() {
    // Decrypted key material lives in storage.session. Content scripts must never read it.
    void browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Nor storage.local: the encrypted vault, RPC URLs (often with API keys) and history.
    // A compromised page renderer could otherwise copy the vault for offline guessing.
    try {
      void browser.storage.local
        .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
        .catch(() => undefined);
    } catch {
      // A browser without access levels for storage.local.
    }

    const local = area(browser.storage.local);
    const vault = new Vault({ local, session: area(browser.storage.session) });
    const settings = new SettingsStore(local);
    const pool = new ClientPool();
    const sendClients = new Map<string, PublicClient>();

    const client = (chain: ChainConfig, cs: ChainSettings) =>
      pool.get(chain, cs.customRpc ? [cs.customRpc] : []);
    /** One client per exact endpoint, for sends that must not fall back elsewhere. */
    const single = (chain: ChainConfig, url: string) => {
      const key = `${chain.id}|${url}`;
      let c = sendClients.get(key);
      if (!c) {
        c = createPublicClient({
          chain: toViemChain(chain),
          transport: http(url, { timeout: 8_000 }),
        });
        sendClients.set(key, c);
      }
      return c;
    };
    /**
     * Where a signed transaction goes: the MEV RPC alone, or (sequencer chains) every
     * endpoint at once since acceptance time varies a lot by provider. Null means a public
     * mempool: keep to the user's RPC order (a custom RPC may be private).
     */
    const sendUrls = (chain: ChainConfig, cs: ChainSettings): string[] | null => {
      if (chain.mev.supported && cs.mevEnabled && cs.mevRpc) return [cs.mevRpc];
      if (chain.mev.supported) return null;
      return [...new Set([...(cs.customRpc ? [cs.customRpc] : []), ...chain.rpcUrls])];
    };
    const broadcast = (chain: ChainConfig, cs: ChainSettings, raw: Hex) => {
      const urls = sendUrls(chain, cs);
      if (!urls) return client(chain, cs).sendRawTransaction({ serializedTransaction: raw });
      return broadcastRaw(
        urls.map((u) => single(chain, u)),
        raw,
      );
    };

    /**
     * Keeps the connections a click will use open (TLS and CORS preflight already done),
     * so the first trade after a pause does not pay for a new handshake.
     */
    const warmedAt = new Map<number, number>();
    const warmRpc = async (chainId: number) => {
      const chain = getChain(chainId);
      if (!chain) return;
      const now = Date.now();
      if (now - (warmedAt.get(chainId) ?? 0) < RPC_WARM_MS) return;
      warmedAt.set(chainId, now);
      const cs = await settings.getChain(chainId);
      const targets = [
        client(chain, cs),
        ...(sendUrls(chain, cs) ?? []).map((u) => single(chain, u)),
      ];
      // eth_blockNumber directly: getBlockNumber() may answer from viem's cache.
      await Promise.allSettled(targets.map((c) => c.request({ method: 'eth_blockNumber' })));
    };

    const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues], [kyberVenue]);
    const prices = new PriceService(routing);
    const tax = new TaxService(routing);
    const aggregatorCheck = new AggregatorCheck(routing, tax);
    const nonces = new NonceManager(async (chainId, address) => {
      const chain = getChain(chainId);
      if (!chain) throw new Error('unsupported_chain');
      const cs = await settings.getChain(chainId);
      return client(chain, cs).getTransactionCount({ address, blockTag: 'pending' });
    });

    /** Tabs whose panel has messaged this worker: broadcasts go there, not to every tab. */
    const panelTabs = new Set<number>();
    // Chrome stops an idle worker, which empties memory, and a locked panel sends nothing
    // that would add its tab again: keep the list in session storage so an unlock after a
    // long pause still reaches it.
    const PANEL_TABS_KEY = 'nesty.panelTabs';
    const panelTabsLoaded = browser.storage.session
      .get(PANEL_TABS_KEY)
      .then((r) => {
        const ids = r[PANEL_TABS_KEY];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') panelTabs.add(id);
      })
      .catch(() => undefined);
    const savePanelTabs = () =>
      void browser.storage.session.set({ [PANEL_TABS_KEY]: [...panelTabs] }).catch(() => undefined);
    const addPanelTab = (id: number) => {
      if (panelTabs.has(id)) return;
      panelTabs.add(id);
      savePanelTabs();
    };
    const dropPanelTab = (id: number) => {
      if (panelTabs.delete(id)) savePanelTabs();
    };
    browser.tabs.onRemoved.addListener(dropPanelTab);

    const push = async (event: PushEvent, tabId?: number) => {
      // Extension pages (popup) listen too; nobody listening is fine.
      void browser.runtime.sendMessage(event).catch(() => undefined);
      if (tabId !== undefined) {
        await browser.tabs.sendMessage(tabId, event).catch(() => undefined);
        return;
      }
      await panelTabsLoaded;
      await Promise.all(
        [...panelTabs].map((id) =>
          // No panel there any more (navigated away): stop sending to it.
          browser.tabs.sendMessage(id, event).catch(() => dropPanelTab(id)),
        ),
      );
    };

    const history = new HistoryStore(local);
    const portfolio = new PortfolioService(local, routing, prices);
    const logos = new LogoService(local);
    // Seed the token list from past trades (tokens bought before portfolio existed). They
    // are the user's own choices, so this also marks them trusted (shown).
    void history.list().then(async (list) => {
      const byChain = new Map<number, Address[]>();
      for (const t of list) {
        if (t.token && (t.kind === 'buy' || t.kind === 'sell')) {
          byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t.token]);
        }
      }
      for (const [chainId, tokens] of byChain) await portfolio.addTokens(chainId, tokens);
    });
    const fees = new FeeCache();

    /**
     * Every ticket update, EVM or Solana: saved to history once it reached the chain, then
     * pushed to the views.
     */
    const recordTicket = (ticket: TradeTicket, tabId?: number) => {
      // Save first so views that re-read history on this event see the new state.
      const saved = history.upsert(ticket);
      // A token is followed once a trade in it was sent, not when the checks stopped one.
      if (
        ticket.token &&
        (ticket.kind === 'buy' || ticket.kind === 'sell') &&
        reachedChain(ticket)
      ) {
        void portfolio.addTokens(ticket.chainId, [ticket.token]);
      }
      // Pushed even when saving failed: the panel must still see the trade's progress.
      const send = () => push({ kind: 'nesty.ticket', ticket }, tabId);
      void saved.then(send, send);
      // The website follows the bridges it started.
      site.noteTicket(ticket);
    };

    // New blocks over WebSocket (optional, per chain): fresh base fee, faster
    // confirmations, and a nudge for open panels to refresh quotes (≤ 1/s per chain).
    const lastBlockPush = new Map<number, number>();
    const ws = new WsHub((chainId, baseFee) => {
      if (baseFee !== null) fees.setBaseFee(chainId, baseFee, Date.now());
      const now = Date.now();
      if (now - (lastBlockPush.get(chainId) ?? 0) >= 1_000) {
        lastBlockPush.set(chainId, now);
        void push({ kind: 'nesty.block', chainId });
      }
    });
    const syncWs = async (chainId: number) => {
      const chain = getChain(chainId);
      if (chain) ws.ensure(chain, (await settings.getChain(chainId)).wsRpc);
    };
    for (const c of CHAINS.values()) void syncWs(c.id);

    // One Relay client for bridges from either side.
    const relay = createRelayClient();
    const engine = new TradeEngine({
      vault,
      settings,
      routing,
      tax,
      aggregatorCheck,
      fees,
      nonces,
      prices,
      client,
      broadcast,
      fetchJson,
      aggregator,
      extraContracts: (chainId) => new Map([...venueRules(chainId), ...launchpadRules(chainId)]),
      notify: recordTicket,
      relay,
      // A new Solana wallet must be paid enough to exist, and an outside address be a wallet.
      solanaPayout: (recipient, minOut): Promise<string | null> =>
        solana.bridge.payoutBlock(recipient, minOut),
      solanaRecipient: (recipient): Promise<string | null> =>
        solana.bridge.recipientBlock(recipient),
      nextBlock: (chainId, timeoutMs) => ws.nextBlock(chainId, timeoutMs),
      now: Date.now,
    });

    // Solana: pump.fun curves, PumpSwap, and the pools and launch curves of the programs in
    // solana/dex. Its tokens are read from the chain, so nothing is added to the EVM token lists.
    const solana = new SolanaService({
      vault,
      settings,
      local,
      history,
      notify: recordTicket,
      // The pool index, while usePoolIndex allows it: finds a coin's pools on other programs,
      // and prices pay tokens no pump.fun route covers.
      fetchJson,
      relay,
      // An outside address paid on an EVM chain must not be a token contract.
      evmTokenAt: async (chainId, address): Promise<string | null> =>
        (await engine.checkRecipient({ chainId, to: address }, [])).tokenSymbol,
      now: Date.now,
    });

    // Take profit / stop loss. An alarm wakes the worker so plans keep being checked
    // while the browser is open; while awake it checks about every second.
    const exits = new ExitWatcher({
      local,
      history,
      vault,
      routing,
      engine,
      solana,
      settings,
      client,
      fetchJson,
      aggregator,
      now: Date.now,
    });
    exits.start();
    void browser.alarms.create(EXITS_ALARM, { periodInMinutes: 0.5 });

    // Price alerts the website sets. While there are any, an alarm wakes the worker every
    // 30 seconds to read their coins' prices; a reached one shows a notification.
    const alerts = new AlertWatcher({
      local,
      fetchJson: (url) => fetchJson(url),
      notify: async (id, title, message) => {
        await browser.notifications.create(id, {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/icon/128.png'),
          title,
          message,
          priority: 2,
        });
      },
      blocked: async () => (await browser.notifications.getPermissionLevel()) === 'denied',
      schedule: async (on) => {
        if (!on) {
          await browser.alarms.clear(ALERTS_ALARM);
          return;
        }
        if (!(await browser.alarms.get(ALERTS_ALARM)))
          await browser.alarms.create(ALERTS_ALARM, { periodInMinutes: ALERT_CHECK_MINUTES });
      },
      newId: () => crypto.randomUUID(),
      now: Date.now,
    });
    void alerts.start().catch(() => undefined);

    // Wallets the website follows. While there are any, an alarm wakes the worker every 30
    // seconds to read their trades; a new one shows a notification.
    const tracker = new TrackerWatcher({
      local,
      fetchJson: (url) => fetchJson(url),
      notify: async (id, title, message, buttons) => {
        await browser.notifications.create(id, {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/icon/128.png'),
          title,
          message,
          priority: 1,
          buttons: buttons.map((b) => ({ title: b })),
        });
      },
      blocked: async () => (await browser.notifications.getPermissionLevel()) === 'denied',
      schedule: async (on) => {
        if (!on) {
          await browser.alarms.clear(TRACKER_ALARM);
          return;
        }
        if (!(await browser.alarms.get(TRACKER_ALARM)))
          await browser.alarms.create(TRACKER_ALARM, { periodInMinutes: TRACK_CHECK_MINUTES });
      },
      sol: async () => solReader(await solana.rpc()),
      evm: async (chainId) => {
        const chain = getChain(chainId);
        return chain ? evmReader(client(chain, await settings.getChain(chainId))) : null;
      },
      evmChains: () => [...CHAINS.keys()],
      newId: () => crypto.randomUUID(),
      now: Date.now,
    });
    void tracker.start().catch(() => undefined);

    // A click on an alert, or on a followed wallet's trade, opens the coin on the site that
    // set it; the trade's second button mutes that wallet.
    browser.notifications.onClicked.addListener((id) => {
      const url = alertPage(id) ?? trackNote(id)?.page;
      if (!url) return;
      void browser.tabs.create({ url });
      void browser.notifications.clear(id);
    });
    browser.notifications.onButtonClicked.addListener((id, button) => {
      const note = trackNote(id);
      if (!note) return;
      if (button === 0) void browser.tabs.create({ url: note.page });
      else void tracker.mute(note.origin, note.walletId).catch(() => undefined);
      void browser.notifications.clear(id);
    });

    // Runtime-enabled sites (on top of the built-in list).
    let enabled = new Set<string>();
    const loadSites = async () => {
      enabled = new Set(await settings.enabledSites());
    };
    /** Senders are classified only once this has run (see the message listener). */
    const sitesLoaded = loadSites().catch(() => undefined);
    const isAllowedOrigin = (origin: string) => isBuiltinOrigin(origin) || enabled.has(origin);

    /**
     * Exactly one registered script per runtime-enabled site that still has its host
     * permission: ids from older versions, or of sites since disabled, are removed.
     */
    const syncSiteScripts = async () => {
      const want = new Map<string, string>();
      for (const origin of enabled) {
        if (await browser.permissions.contains({ origins: [`${origin}/*`] }))
          want.set(siteScriptId(origin), origin);
      }
      const have = await browser.scripting.getRegisteredContentScripts();
      const stale = have
        .filter((s) => s.id.startsWith('site-') && !want.has(s.id))
        .map((s) => s.id);
      if (stale.length) await browser.scripting.unregisterContentScripts({ ids: stale });
      const missing = [...want].filter(([id]) => !have.some((s) => s.id === id));
      if (missing.length)
        await browser.scripting.registerContentScripts(
          missing.map(([id, origin]) => ({
            id,
            matches: [`${origin}/*`],
            js: [CONTENT_SCRIPT],
            runAt: 'document_idle' as const,
            allFrames: false,
          })),
        );
    };
    void sitesLoaded.then(syncSiteScripts).catch(() => undefined);

    const sites: SiteControl = {
      async status(origin) {
        return { builtin: isBuiltinOrigin(origin), enabled: isAllowedOrigin(origin) };
      },
      async enable(origin, tabId) {
        if (isBuiltinOrigin(origin)) return { builtin: true, enabled: true };
        // The Nesty website does its own trading: never a panel there.
        if (isNestySite(origin)) return { builtin: false, enabled: false };
        // The popup asked for the permission (user gesture); we only proceed if it was granted.
        const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
        if (!granted) throw Object.assign(new Error('permission_denied'));
        const id = siteScriptId(origin);
        const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
        if (existing.length === 0) {
          await browser.scripting.registerContentScripts([
            {
              id,
              matches: [`${origin}/*`],
              js: [CONTENT_SCRIPT],
              runAt: 'document_idle',
              allFrames: false,
            },
          ]);
        }
        await settings.setEnabledSites([...enabled, origin]);
        await loadSites();
        await browser.scripting
          .executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] })
          .catch(() => undefined);
        return { builtin: false, enabled: true };
      },
      async disable(origin) {
        if (isBuiltinOrigin(origin)) return { builtin: true, enabled: true };
        await browser.scripting
          .unregisterContentScripts({ ids: [siteScriptId(origin)] })
          .catch(() => undefined);
        await browser.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
        await settings.setEnabledSites([...enabled].filter((o) => o !== origin));
        await loadSites();
        return { builtin: false, enabled: false };
      },
    };

    // The Nesty website: its buys and sells are the extension's own, as the panel's are.
    const site = new SiteService({
      vault,
      solana,
      engine,
      // Its panel's quotes keep the routes, fees and nonces its trades use warm.
      quotes: (req) =>
        panelQuotes(
          {
            settings,
            client,
            fetchJson,
            aggregator,
            now: Date.now,
            vault,
            history,
            prices,
            routing,
            tax,
            aggregatorCheck,
            engine,
          },
          req,
        ),
      // Its tab alone hears how the trades it asked for go.
      pushTicket: (tabId, ticket) => {
        const event: PushEvent = { kind: 'nesty.site.ticket', ticket };
        void browser.tabs.sendMessage(tabId, event).catch(() => undefined);
      },
      // Bridges it asks for are the extension's own: quoted, checked and sent here.
      bridge: {
        quote: (req) =>
          isSolana(req.fromChainId) ? solana.bridge.quote(req) : engine.bridgeQuote(req),
        send: (req) => (isSolana(req.fromChainId) ? solana.bridge.bridge(req) : engine.bridge(req)),
      },
      alerts,
      tracker,
      // What it still builds itself is built again here from the venues the panel uses.
      evm: new SiteEvmChecker({
        settings,
        client,
        fetchJson,
        routing,
        prices,
        fees,
        extraContracts: (chainId) => new Map([...venueRules(chainId), ...launchpadRules(chainId)]),
        now: Date.now,
      }),
      settings,
      local,
      // nesty.trade is Nesty's own: connected from the start, until the user turns it off.
      connectedByDefault: HOSTED_SITE_ORIGINS,
      openApproval: async (id) =>
        (
          await browser.windows.create({
            url: `${browser.runtime.getURL('/approve.html')}?id=${encodeURIComponent(id)}`,
            type: 'popup',
            width: 380,
            height: 540,
            focused: true,
          })
        )?.id,
      // `for=site`: the popup closes itself once unlocked, its job for the site done.
      openUnlock: async () =>
        (
          await browser.windows.create({
            url: browser.runtime.getURL('/popup.html?for=site'),
            type: 'popup',
            width: 380,
            height: 640,
            focused: true,
          })
        )?.id,
      newId: () => crypto.randomUUID(),
      version: browser.runtime.getManifest().version,
      now: Date.now,
    });
    browser.windows.onRemoved.addListener((id) => site.windowClosed(id));

    // The PnL card's window: one at a time, brought forward with each new card.
    let shareWindow: number | undefined;
    browser.windows.onRemoved.addListener((id) => {
      if (id === shareWindow) shareWindow = undefined;
    });
    const openShare = async (card: PnlCard) => {
      await browser.storage.session.set({ [SHARE_KEY]: card });
      if (shareWindow !== undefined) {
        try {
          await browser.windows.update(shareWindow, { focused: true });
          return;
        } catch {
          shareWindow = undefined;
        }
      }
      shareWindow = (
        await browser.windows.create({
          url: browser.runtime.getURL('/share.html'),
          type: 'popup',
          width: 720,
          height: 680,
          focused: true,
        })
      )?.id;
    };

    const deps: RouterDeps = {
      history,
      portfolio,
      logos,
      exits,
      wsStatus: (chainId) => ws.status(chainId),
      warmRpc,
      onChainSettings: (chainId) => void syncWs(chainId),
      vault,
      settings,
      engine,
      solana,
      routing,
      tax,
      aggregatorCheck,
      prices,
      sites,
      site,
      client,
      fetchJson,
      aggregator,
      version: browser.runtime.getManifest().version,
      now: Date.now,
      async onActivity() {
        const { autoLockMinutes } = await settings.get();
        await browser.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: autoLockMinutes });
      },
      async onLockChanged(unlocked) {
        if (unlocked) await deps.onActivity();
        else await browser.alarms.clear(AUTOLOCK_ALARM);
        await push({ kind: 'nesty.vault', unlocked });
      },
      async scheduleClipboardClear() {
        await closeOffscreen();
        await browser.offscreen.createDocument({
          url: `${OFFSCREEN_PATH}?clearAfter=${CLIPBOARD_CLEAR_MS}`,
          reasons: ['CLIPBOARD'],
          justification: 'Clear an exported private key from the clipboard after 30 seconds.',
        });
      },
      closeOffscreen,
      openShare,
    };

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === EXITS_ALARM) exits.start();
      if (alarm.name === ALERTS_ALARM) void alerts.check().catch(() => undefined);
      if (alarm.name === TRACKER_ALARM) void tracker.check().catch(() => undefined);
      if (alarm.name === AUTOLOCK_ALARM)
        void vault.lock().then(() => push({ kind: 'nesty.vault', unlocked: false }));
    });

    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === 'install')
        void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    });

    browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      // A message from a panel may be what wakes the worker: wait for the runtime-enabled
      // sites to load, or a panel on such a site would be turned away on that first click.
      void sitesLoaded.then(() => {
        const kind = classifySender(sender, browser.runtime.id, isAllowedOrigin);
        if (!kind) return sendResponse(undefined);
        // Both hear when the vault locks or unlocks (the website's script passes on only that).
        if (kind !== 'extension-page' && kind !== 'extension-frame' && sender.tab?.id !== undefined)
          addPanelTab(sender.tab.id);
        const meta = { kind, tabId: sender.tab?.id, origin: sender.origin ?? originOf(sender.url) };
        void handleMessage(raw, meta, deps).then(sendResponse);
      });
      return true;
    });
  },
});

async function closeOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument();
}
