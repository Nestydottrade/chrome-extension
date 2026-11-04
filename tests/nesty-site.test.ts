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

  it('is the local development server, exactly, outside the store build', async () => {
    const s = await site();
    expect(s.isNestySite('http://localhost:5173')).toBe(true);
    expect(s.isNestySite('http://127.0.0.1:5173')).toBe(true);
    expect(s.isNestySite('http://localhost:5174')).toBe(false);
    expect(s.isNestySite('https://localhost:5173')).toBe(false);
    expect(s.NESTY_SITE_MATCHES).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
  });

  it('is nowhere in the store build', async () => {
    const s = await site(true);
    expect(s.NESTY_SITE_ORIGINS).toEqual([]);
    expect(s.NESTY_SITE_MATCHES).toEqual([]);
    expect(s.isNestySite('http://localhost:5173')).toBe(false);
    expect(s.isNestySite('http://127.0.0.1:5173')).toBe(false);
  });

  it('decides whether the manifest asks for notifications (its price alerts)', async () => {
    const normal = await permissions(false);
    const store = await permissions(true);
    expect(normal).toContain('notifications');
    expect(store).not.toContain('notifications');
    expect(store).toEqual(normal.filter((p) => p !== 'notifications'));
  });
});
