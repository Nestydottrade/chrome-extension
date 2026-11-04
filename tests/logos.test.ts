import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPFS_GATEWAY, LogoService, ipfsCid } from '../src/background/logos';
import type { KeyValueStore } from '../src/background/vault/vault';
import { RequestSchema } from '../src/shared/messages';
import { SOLANA_CHAIN_ID } from '../src/shared/solana';

class Store implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(k: string) {
    return this.data.get(k);
  }
  async set(k: string, v: unknown) {
    this.data.set(k, structuredClone(v));
  }
  async remove(k: string) {
    this.data.delete(k);
  }
  async getAll() {
    return Object.fromEntries(this.data);
  }
}

// CIDs in the shapes pump.fun uses: v0 for metadata, v1 (base32) for images.
const META_CID = 'QmfTBRKZ8o9WHZdiewpSVUysPQw5UfekStRQLJPeKuJksZ';
const IMAGE_CID = 'bafybeifaqalaatdc5x2hzpk57nurzu4df5vxroycz46i6bxllm7i5iwsde';
const MINT = '6szRmQi8dY8QQgoLccmLhJFpgwna2M5ddheHdisbpump';
const CDN = 'https://dd.dexscreener.com/ds-data';

describe('IPFS addresses in metadata', () => {
  it('finds the CID whichever gateway a URI names', () => {
    expect(ipfsCid(`https://ipfs.io/ipfs/${META_CID}`)).toBe(META_CID);
    expect(ipfsCid(`https://pump.mypinata.cloud/ipfs/${IMAGE_CID}?img-width=128`)).toBe(IMAGE_CID);
    expect(ipfsCid(`ipfs://${IMAGE_CID}`)).toBe(IMAGE_CID);
    expect(ipfsCid(`ipfs://ipfs/${META_CID}`)).toBe(META_CID);
    expect(ipfsCid(`https://${IMAGE_CID}.ipfs.4everland.io/`)).toBe(IMAGE_CID);
  });

  it('finds none elsewhere, behind a path, or in a malformed CID', () => {
    expect(ipfsCid('https://arweave.net/abc123')).toBeNull();
    expect(ipfsCid('https://example.com/meta.json')).toBeNull();
    expect(ipfsCid(`https://ipfs.io/ipfs/${META_CID}/image.png`)).toBeNull();
    expect(ipfsCid('https://ipfs.io/ipfs/Qm123')).toBeNull();
    expect(ipfsCid(`https://ipfs.io/ipfs/${META_CID}%2F..`)).toBeNull();
    expect(ipfsCid('')).toBeNull();
  });
});

/** Answers by URL: JSON, an image, a status. Records every URL asked for. */
function serve(routes: Record<string, { json?: unknown; image?: number; status?: number }>) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const r = routes[url];
      if (!r) return new Response('not found', { status: 404 });
      if (r.status) return new Response('busy', { status: r.status });
      if (r.json !== undefined)
        return new Response(JSON.stringify(r.json), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response(new Uint8Array(r.image ?? 10), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ close() {} })),
  );
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('Solana token logos', () => {
  const metaUrl = `${IPFS_GATEWAY}${META_CID}`;
  const imageUrl = `${IPFS_GATEWAY}${IMAGE_CID}?img-width=64&img-dpr=2`;

  it("take the image a coin's IPFS metadata names, through the one gateway only", async () => {
    const asked = serve({
      [metaUrl]: { json: { name: 'Coin', image: `https://ipfs.io/ipfs/${IMAGE_CID}` } },
      [imageUrl]: { image: 3_000 },
    });
    const store = new Store();
    const url = await new LogoService(store).solana(MINT, `https://ipfs.io/ipfs/${META_CID}`);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    // The hosts the metadata names are never contacted.
    expect(asked).toEqual([metaUrl, imageUrl]);
    expect(store.data.get(`nesty.logo.solana.${MINT}`)).toMatchObject({ url });
  });

  it("fall back to DEX Screener's, by the mint as it is spelled", async () => {
    const dex = `${CDN}/tokens/solana/${MINT}.png`;
    const asked = serve({ [metaUrl]: { json: { name: 'Coin' } }, [dex]: { image: 10 } });
    const logos = new LogoService(new Store());
    // No image in the metadata, then metadata off IPFS: DEX Screener either way.
    expect(await logos.solana(MINT, `https://ipfs.io/ipfs/${META_CID}`)).toMatch(/^data:image/);
    expect(asked).toEqual([metaUrl, dex]);
    asked.length = 0;
    const other = MINT.toLowerCase();
    expect(await logos.solana(other, 'https://example.com/meta.json')).toBeNull();
    expect(asked).toEqual([`${CDN}/tokens/solana/${other}.png`]);
  });

  it('keep mints that differ only in case apart', async () => {
    serve({ [`${CDN}/tokens/solana/${MINT}.png`]: { image: 10 } });
    const store = new Store();
    const logos = new LogoService(store);
    await logos.solana(MINT, null);
    await logos.solana(MINT.toLowerCase(), null);
    expect(store.data.get(`nesty.logo.solana.${MINT}`)).toMatchObject({ url: expect.any(String) });
    expect(store.data.get(`nesty.logo.solana.${MINT.toLowerCase()}`)).toMatchObject({ url: null });
  });

  it('are asked again later when the gateway is busy, not taken as missing', async () => {
    const asked = serve({ [metaUrl]: { status: 429 } });
    const store = new Store();
    expect(await new LogoService(store).solana(MINT, `ipfs://${META_CID}`)).toBeNull();
    expect(asked).toEqual([metaUrl]);
    expect(store.data.has(`nesty.logo.solana.${MINT}`)).toBe(false);
  });

  it('refuse images over the size limit without reading them whole', async () => {
    serve({
      [metaUrl]: { json: { image: `ipfs://${IMAGE_CID}` } },
      [imageUrl]: { image: 300_000 },
    });
    expect(await new LogoService(new Store()).solana(MINT, `ipfs://${META_CID}`)).toBeNull();
  });
});

describe('chain logos', () => {
  it("come from DEX Screener's chain icons and are cached", async () => {
    const asked = serve({ [`${CDN}/chains/solana.png`]: { image: 10 } });
    const store = new Store();
    const logos = new LogoService(store);
    expect(await logos.chain('solana')).toMatch(/^data:image/);
    expect(await logos.chain('solana')).toMatch(/^data:image/);
    expect(asked).toEqual([`${CDN}/chains/solana.png`]);
    expect(store.data.has('nesty.logo.chain.solana')).toBe(true);
  });
});

describe('logo requests', () => {
  const ok = (chainId: number, token: string) =>
    RequestSchema.safeParse({ type: 'logo.get', chainId, token }).success;

  it('name a mint on Solana and a 0x address elsewhere, or the native coin on either', () => {
    expect(ok(SOLANA_CHAIN_ID, MINT)).toBe(true);
    expect(ok(SOLANA_CHAIN_ID, 'native')).toBe(true);
    expect(ok(8453, '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed')).toBe(true);
    expect(ok(8453, MINT)).toBe(false);
    expect(ok(SOLANA_CHAIN_ID, '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed')).toBe(false);
    expect(RequestSchema.safeParse({ type: 'logo.chain', chainId: SOLANA_CHAIN_ID }).success).toBe(
      true,
    );
  });
});
