import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { PushEvent, Request } from '../shared/messages';
import { readBlockedActions } from '../shared/panel';
import {
  EXTENSION_SOURCE,
  SITE_METHODS,
  SITE_SOURCE,
  type SiteMethod,
  type SitePageEvent,
  type SitePageRequest,
  type SitePageResponse,
} from '../shared/site-bridge';
import { NESTY_SITE_MATCHES, isNestySite } from '../shared/nesty-site';

/**
 * On the Nesty website only, and instead of the panel: carries the site's requests
 * (window messages from the page itself) to the background and the answers back. What a
 * request may do is decided there (SITE_TYPES and the checks behind them), never here.
 */
export default defineContentScript({
  matches: NESTY_SITE_MATCHES,
  runAt: 'document_start',
  main(ctx) {
    if (window.top !== window || !isNestySite(location.origin)) return;
    const post = (msg: SitePageResponse | SitePageEvent) =>
      window.postMessage(msg, location.origin);

    ctx.addEventListener(window, 'message', (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const req: unknown = e.data;
      if (!isRequest(req)) return;
      const params = typeof req.params === 'object' && req.params !== null ? req.params : {};
      // The method's own type last: whatever the page put in its params cannot replace it.
      void browser.runtime
        .sendMessage({ ...params, type: SITE_METHODS[req.method] } as Request)
        .then((res: unknown) => post(answer(req.id, res)))
        .catch(() => post({ source: EXTENSION_SOURCE, id: req.id, ok: false, error: 'internal' }));
    });

    // Only the vault's lock state reaches the page; tickets and blocks stay in the extension.
    browser.runtime.onMessage.addListener((msg: unknown) => {
      const ev = msg as PushEvent | undefined;
      if (ev?.kind === 'nesty.vault')
        post({ source: EXTENSION_SOURCE, event: 'vault', unlocked: ev.unlocked });
    });

    // Page scripts start after this one: they can listen for this, or ask with a hello.
    ctx.addEventListener(document, 'DOMContentLoaded', () =>
      post({ source: EXTENSION_SOURCE, event: 'ready' }),
    );
  },
});

function isRequest(data: unknown): data is SitePageRequest {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Partial<SitePageRequest>;
  return (
    r.source === SITE_SOURCE &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    r.id.length <= 64 &&
    typeof r.method === 'string' &&
    Object.hasOwn(SITE_METHODS, r.method as SiteMethod)
  );
}

function answer(id: string, res: unknown): SitePageResponse {
  const r = res as
    | { ok?: boolean; data?: unknown; error?: string; detail?: string; actions?: unknown }
    | undefined;
  if (r?.ok === true) return { source: EXTENSION_SOURCE, id, ok: true, data: r.data };
  const actions = readBlockedActions(r?.actions);
  return {
    source: EXTENSION_SOURCE,
    id,
    ok: false,
    error: typeof r?.error === 'string' ? r.error : 'internal',
    ...(typeof r?.detail === 'string' ? { detail: r.detail } : {}),
    ...(actions ? { actions } : {}),
  };
}
