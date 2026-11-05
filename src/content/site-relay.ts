import type { Request } from '../shared/messages';
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

export interface RelayDeps {
  /** browser.runtime.sendMessage: it throws, rather than rejects, once Nesty is gone. */
  send: (msg: Request) => Promise<unknown>;
  /** False once Nesty was updated or reloaded since the page loaded. */
  alive: () => boolean;
  post: (msg: SitePageResponse | SitePageEvent) => void;
}

/**
 * Carries the Nesty website's requests to the background and the answers back. What a
 * request may do is decided there (SITE_TYPES and the checks behind them), never here.
 *
 * Once Nesty is updated or reloaded, the old content script stays in the page but can no
 * longer reach it: every request is then answered "reloaded", and the page is told once
 * (event "gone"), so it can ask the user to reload.
 */
export function siteRelay(d: RelayDeps): (data: unknown) => void {
  let told = false;
  const reloaded = (id: string) => {
    if (!told) {
      told = true;
      d.post({ source: EXTENSION_SOURCE, event: 'gone' });
    }
    d.post({ source: EXTENSION_SOURCE, id, ok: false, error: 'reloaded' });
  };

  return (data) => {
    if (!isRequest(data)) return;
    const { id } = data;
    if (!d.alive()) {
      reloaded(id);
      return;
    }
    const params = typeof data.params === 'object' && data.params !== null ? data.params : {};
    let sent: Promise<unknown>;
    try {
      // The method's own type last: whatever the page put in its params cannot replace it.
      sent = d.send({ ...params, type: SITE_METHODS[data.method] } as Request);
    } catch {
      reloaded(id);
      return;
    }
    void sent.then(
      (res) => d.post(answer(id, res)),
      () => {
        if (d.alive()) d.post({ source: EXTENSION_SOURCE, id, ok: false, error: 'internal' });
        else reloaded(id);
      },
    );
  };
}

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
