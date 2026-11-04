import { afterEach, describe, expect, it, vi } from 'vitest';

/** Modules load afresh, as in a build: what they trust is fixed when they load. */
function fresh(store: boolean) {
  vi.resetModules();
  if (store) vi.stubEnv('WXT_STORE', 'true');
}

async function site(store = false) {
  fresh(store);
  return import('../src/shared/nesty-site');
}

/** The manifest's permissions, as `pnpm build` or `pnpm build:store` writes them. */
async function permissions(store: boolean): Promise<string[]> {
  fresh(store);
  const { manifest } = (await import('../wxt.config')).default;
  if (!manifest || typeof manifest === 'function' || manifest instanceof Promise)
    throw new Error('the manifest is a plain object');
  return manifest.permissions ?? [];
}

describe('the Nesty website', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is the hosted site and, outside the store build, the local development server', async () => {
    const s = await site();
    expect(s.isNestySite('https://nesty.trade')).toBe(true);
    expect(s.isNestySite('http://localhost:5173')).toBe(true);
    expect(s.isNestySite('http://127.0.0.1:5173')).toBe(true);
    expect(s.isNestySite('http://localhost:5174')).toBe(false);
    expect(s.isNestySite('https://localhost:5173')).toBe(false);
    expect(s.NESTY_SITE_MATCHES).toEqual([
      'https://nesty.trade/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
  });

  it('is the hosted site only in the store build', async () => {
    const s = await site(true);
    expect(s.NESTY_SITE_ORIGINS).toEqual(['https://nesty.trade']);
    expect(s.NESTY_SITE_MATCHES).toEqual(['https://nesty.trade/*']);
    expect(s.isNestySite('http://localhost:5173')).toBe(false);
    expect(s.isNestySite('http://127.0.0.1:5173')).toBe(false);
  });

  it('is that exact origin: no other scheme, host or port', async () => {
    for (const store of [false, true]) {
      const s = await site(store);
      for (const origin of [
        'http://nesty.trade',
        'https://www.nesty.trade',
        'https://nesty.trade:8443',
        'https://nesty.trade.example.com',
        'https://evilnesty.trade',
      ])
        expect(s.isNestySite(origin)).toBe(false);
    }
  });

  it('asks for notifications, for its price alerts, in every build', async () => {
    const normal = await permissions(false);
    const store = await permissions(true);
    expect(normal).toContain('notifications');
    expect(store).toEqual(normal);
  });
});
