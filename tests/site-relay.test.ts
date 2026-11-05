import { describe, expect, it } from 'vitest';
import { siteRelay, type RelayDeps } from '../src/content/site-relay';
import {
  EXTENSION_SOURCE,
  SITE_SOURCE,
  type SitePageEvent,
  type SitePageResponse,
} from '../src/shared/site-bridge';

const ask = (id: string, method: string, params?: unknown) => ({
  source: SITE_SOURCE,
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const settle = () => new Promise((r) => setTimeout(r, 0));

function relayWith(send: RelayDeps['send'], alive: () => boolean = () => true) {
  const posted: (SitePageResponse | SitePageEvent)[] = [];
  const relay = siteRelay({ send, alive, post: (m) => posted.push(m) });
  return { relay, posted };
}

const GONE = { source: EXTENSION_SOURCE, event: 'gone' };
const reloaded = (id: string) => ({ source: EXTENSION_SOURCE, id, ok: false, error: 'reloaded' });

describe('the Nesty website relay', () => {
  it('sends a request under its own type, whatever its params say, and posts the answer', async () => {
    const sent: unknown[] = [];
    const { relay, posted } = relayWith((msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true, data: { n: 1 } });
    });
    relay(ask('a', 'trackerFeed', { type: 'vault.export', extra: 1 }));
    await settle();
    expect(sent).toEqual([{ extra: 1, type: 'site.tracker.feed' }]);
    expect(posted).toEqual([{ source: EXTENSION_SOURCE, id: 'a', ok: true, data: { n: 1 } }]);
  });

  it('ignores anything that is not one of the site methods', async () => {
    const sent: unknown[] = [];
    const { relay, posted } = relayWith((msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true, data: null });
    });
    relay({ source: 'someone', id: 'a', method: 'hello' });
    relay(ask('', 'hello'));
    relay(ask('b', 'exportKey'));
    relay(ask('c', 'toString'));
    relay(null);
    await settle();
    expect(sent).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("passes on Nesty's refusal, and answers internal when a request fails while Nesty is there", async () => {
    let call = 0;
    const { relay, posted } = relayWith(() =>
      ++call === 1
        ? Promise.resolve({ ok: false, error: 'locked', detail: 'Unlock first.' })
        : Promise.reject(new Error('Could not establish connection.')),
    );
    relay(ask('a', 'wallets'));
    relay(ask('b', 'wallets'));
    await settle();
    expect(posted).toEqual([
      { source: EXTENSION_SOURCE, id: 'a', ok: false, error: 'locked', detail: 'Unlock first.' },
      { source: EXTENSION_SOURCE, id: 'b', ok: false, error: 'internal' },
    ]);
  });

  it('answers reloaded once Nesty was updated, and tells the page once', async () => {
    let alive = true;
    const { relay, posted } = relayWith(
      () => {
        throw new Error('Extension context invalidated.');
      },
      () => alive,
    );
    // The old script's sendMessage throws, not rejects: nothing may escape to the page.
    expect(() => relay(ask('a', 'hello'))).not.toThrow();
    alive = false;
    relay(ask('b', 'wallets'));
    await settle();
    expect(posted).toEqual([GONE, reloaded('a'), reloaded('b')]);
  });

  it('answers reloaded when Nesty goes while a request waits', async () => {
    let alive = true;
    const { relay, posted } = relayWith(
      () => {
        alive = false;
        return Promise.reject(new Error('Extension context invalidated.'));
      },
      () => alive,
    );
    relay(ask('a', 'trackerFeed'));
    await settle();
    expect(posted).toEqual([GONE, reloaded('a')]);
  });
});
