import { describe, expect, it } from 'vitest';
import { isAllowed } from '../src/background/router';
import { classifySender } from '../src/background/sender';
import { RequestSchema, type RequestType } from '../src/shared/messages';
import { isBuiltinOrigin } from '../src/shared/sites';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT = `chrome-extension://${ID}`;
const tab = { id: 1 };

describe('classifySender', () => {
  it('accepts the popup and offscreen document', () => {
    expect(classifySender({ id: ID, url: `${EXT}/popup.html` }, ID, isBuiltinOrigin)).toBe(
      'extension-page',
    );
  });

  it('treats the onboarding tab as an extension page', () => {
    expect(
      classifySender(
        { id: ID, tab, frameId: 0, url: `${EXT}/onboarding.html` },
        ID,
        isBuiltinOrigin,
      ),
    ).toBe('extension-page');
  });

  it('treats an embedded extension iframe as extension-frame', () => {
    expect(
      classifySender({ id: ID, tab, frameId: 7, url: `${EXT}/unlock.html` }, ID, isBuiltinOrigin),
    ).toBe('extension-frame');
  });

  it('accepts a top-frame content script on a built-in site', () => {
    expect(
      classifySender(
        {
          id: ID,
          tab,
          frameId: 0,
          origin: 'https://gmgn.ai',
          url: 'https://gmgn.ai/base/token/0x1',
        },
        ID,
        isBuiltinOrigin,
      ),
    ).toBe('content-script');
  });

  it('knows the Nesty website by its exact origin, plain http included for its dev server', () => {
    const site = { id: ID, tab, frameId: 0, origin: 'http://localhost:5173' };
    expect(classifySender(site, ID, isBuiltinOrigin)).toBe('nesty-site');
    // Even where the panel were enabled, that origin is the website's, never a panel's.
    expect(classifySender(site, ID, () => true)).toBe('nesty-site');
    for (const origin of ['http://localhost:5174', 'http://localhost', 'https://localhost:5173'])
      expect(classifySender({ ...site, origin }, ID, isBuiltinOrigin)).toBeNull();
    expect(classifySender({ ...site, frameId: 2 }, ID, isBuiltinOrigin)).toBeNull();
  });

  it.each([
    ['other extension', { id: 'other', tab, frameId: 0, origin: 'https://gmgn.ai' }],
    ['missing id', { tab, frameId: 0, origin: 'https://gmgn.ai' }],
    ['sub-frame', { id: ID, tab, frameId: 3, origin: 'https://gmgn.ai' }],
    ['unlisted origin', { id: ID, tab, frameId: 0, origin: 'https://evil.example' }],
    ['look-alike origin', { id: ID, tab, frameId: 0, origin: 'https://gmgn.ai.evil.example' }],
    ['http origin', { id: ID, tab, frameId: 0, origin: 'http://gmgn.ai' }],
    ['foreign extension page', { id: ID, url: 'chrome-extension://other/popup.html' }],
  ])('rejects %s', (_label, sender) => {
    expect(classifySender(sender, ID, isBuiltinOrigin)).toBeNull();
  });
});

describe('RequestSchema', () => {
  it('accepts known requests', () => {
    expect(RequestSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'vault.unlock', password: 'x' }).success).toBe(true);
  });

  it.each([
    null,
    'ping',
    {},
    { type: 'exportKey' },
    { type: 'ping', extra: 1 },
    { type: ['ping'] },
    { type: 'vault.reset', confirm: 'yes' },
    { type: 'wallets.exportKey', id: 'a' },
    { type: 'settings.update', patch: { autoLockMinutes: 0 } },
    { type: 'settings.update', patch: { unknownKey: 1 } },
  ])('rejects %j', (input) => {
    expect(RequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('isAllowed', () => {
  const SENSITIVE: RequestType[] = [
    'vault.create',
    'vault.reset',
    'vault.changePassword',
    'wallets.exportKey',
    'wallets.importKey',
    'wallets.remove',
    'settings.update',
    'send.prepare',
    'send.checkRecipient',
    'send.execute',
  ];

  it.each(SENSITIVE)('content scripts cannot call %s', (type) => {
    expect(isAllowed('content-script', type)).toBe(false);
    expect(isAllowed('extension-frame', type)).toBe(false);
    expect(isAllowed('extension-page', type)).toBe(true);
  });

  it('content scripts may keep RPC connections warm', () => {
    expect(isAllowed('content-script', 'rpc.warm')).toBe(true);
    expect(RequestSchema.safeParse({ type: 'rpc.warm', chainId: 4663 }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'rpc.warm', chainId: 4663, url: 'x' }).success).toBe(
      false,
    );
  });

  it('the Nesty website may connect, ask for trades to be signed, bridges, price alerts and followed wallets, and nothing else', () => {
    const site = [...RequestSchema.options]
      .map((o) => o.shape.type.value as RequestType)
      .filter((type) => isAllowed('nesty-site', type));
    expect(site.sort()).toEqual([
      'site.alerts.list',
      'site.alerts.remove',
      'site.alerts.set',
      'site.bridge.quote',
      'site.bridge.send',
      'site.bridge.status',
      'site.connect',
      'site.disconnect',
      'site.evm.permit',
      'site.evm.sign',
      'site.hello',
      'site.sol.sign',
      'site.tracker.edit',
      'site.tracker.feed',
      'site.tracker.follow',
      'site.tracker.prefs',
      'site.tracker.unfollow',
      'site.unlock',
      'site.wallets',
    ]);
    // Approving its own requests is the user's, in an extension page.
    for (const type of ['site.decide', 'site.pending', 'site.revoke'] as const) {
      expect(isAllowed('nesty-site', type)).toBe(false);
      expect(isAllowed('content-script', type)).toBe(false);
    }
    expect(isAllowed('content-script', 'site.sol.sign')).toBe(false);
    expect(isAllowed('content-script', 'site.evm.sign')).toBe(false);
    expect(isAllowed('content-script', 'site.evm.permit')).toBe(false);
    expect(isAllowed('content-script', 'site.bridge.send')).toBe(false);
    expect(isAllowed('content-script', 'site.alerts.set')).toBe(false);
    expect(isAllowed('content-script', 'site.tracker.follow')).toBe(false);
  });

  it('content scripts cannot unlock (password must not be typed into a page)', () => {
    expect(isAllowed('content-script', 'vault.unlock')).toBe(false);
    expect(isAllowed('extension-frame', 'vault.unlock')).toBe(true);
  });
});
