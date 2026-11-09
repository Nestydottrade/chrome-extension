import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { siteRelay } from '../content/site-relay';
import type { PushEvent } from '../shared/messages';
import { EXTENSION_SOURCE, type SitePageEvent, type SitePageResponse } from '../shared/site-bridge';
import { NESTY_SITE_MATCHES, isNestySite } from '../shared/nesty-site';
import { extensionAlive } from '../ui/runtime';

/**
 * On the Nesty website only, and instead of the panel: carries the site's requests
 * (window messages from the page itself) to the background and the answers back
 * (site-relay.ts).
 */
export default defineContentScript({
  matches: NESTY_SITE_MATCHES,
  runAt: 'document_start',
  main(ctx) {
    if (window.top !== window || !isNestySite(location.origin)) return;
    const post = (msg: SitePageResponse | SitePageEvent) =>
      window.postMessage(msg, location.origin);

    const relay = siteRelay({
      send: (msg) => browser.runtime.sendMessage(msg),
      alive: extensionAlive,
      post,
    });
    ctx.addEventListener(window, 'message', (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      relay(e.data);
    });

    // The vault's lock state, and the trades this site asked for (the background sends those
    // to its tab alone); nothing else the extension does reaches the page.
    browser.runtime.onMessage.addListener((msg: unknown) => {
      const ev = msg as PushEvent | undefined;
      if (ev?.kind === 'nesty.vault')
        post({ source: EXTENSION_SOURCE, event: 'vault', unlocked: ev.unlocked });
      else if (ev?.kind === 'nesty.site.ticket')
        post({ source: EXTENSION_SOURCE, event: 'ticket', ticket: ev.ticket });
    });

    // Page scripts start after this one: they can listen for this, or ask with a hello.
    ctx.addEventListener(document, 'DOMContentLoaded', () =>
      post({ source: EXTENSION_SOURCE, event: 'ready' }),
    );
  },
});
