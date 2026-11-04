import type { Address } from 'viem';
import { toBase64 } from '../shared/base64';
import type { ChainConfig } from '../shared/chains';
import type { SolAddress } from '../shared/solana';
import type { KeyValueStore } from './vault/vault';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_BYTES = 200_000;
/** A coin's metadata JSON is a few hundred bytes. */
const MAX_JSON_BYTES = 16_000;
const RETRY_MISSING_MS = 24 * 60 * 60_000;
const PREFIX = 'nesty.logo.';
const KEY = (chainId: number, token: string) => `${PREFIX}${chainId}.${token.toLowerCase()}`;
/** Solana mints are base58: their case is part of them. */
const SOL_KEY = (mint: SolAddress) => `${PREFIX}solana.${mint}`;
const CHAIN_KEY = (slug: string) => `${PREFIX}chain.${slug}`;
const INDEX_KEY = 'nesty.logoIndex';
/**
 * The cache shares storage.local (10 MB, with the vault, settings and history), so it is
 * bounded: oldest entries go first once either limit is reached.
 */
export const LOGO_CACHE_MAX_ENTRIES = 300;
export const LOGO_CACHE_MAX_CHARS = 3_000_000;

const CDN = 'https://dd.dexscreener.com/ds-data';
/**
 * pump.fun's own IPFS gateway, where the metadata and images of coins launched on pump.fun
 * are pinned. It answers with CORS headers (no host permission needed) and scales images
 * down when asked. Only CIDs go through it: the host a coin's metadata names is never
 * contacted (coins launched through other tools may name any host).
 */
export const IPFS_GATEWAY = 'https://pump.mypinata.cloud/ipfs/';
/** Logos are shown at 30 px at most: asked for at twice that, for sharp screens. */
const LOGO_PX = 64;
/** CIDv0 (base58, Qm…) or CIDv1 in base32 (b…). */
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;

/** The IPFS CID a URI points at, through whichever gateway it names; null when none. */
export function ipfsCid(uri: string): string | null {
  const m =
    /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)$/.exec(uri) ??
    /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)\/?(?:[?#].*)?$/.exec(uri) ??
    /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+\/?(?:[?#].*)?$/.exec(uri);
  const cid = m?.[1];
  return cid && CID.test(cid) ? cid : null;
}

interface CachedLogo {
  /** data: URL, or null when there is no logo. */
  url: string | null;
  at: number;
}

/** Cache entries in write order (oldest first) with their size, to evict without reading them. */
interface IndexEntry {
  k: string;
  n: number;
}

/**
 * Token and chain logos, fetched by the background (never by a page), restricted to raster
 * formats and a small size, decoded once to make sure the bytes are really an image, then
 * cached as a data: URL. SVG is refused on purpose. EVM tokens and chains come from DEX
 * Screener's image CDN; Solana tokens from the image their metadata names on IPFS, else
 * from DEX Screener.
 */
export class LogoService {
  private readonly inflight = new Map<string, Promise<string | null>>();
  private index: IndexEntry[] | null = null;
  /** Index updates are serialised; a failed one does not block the next. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly local: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** `token` = 'native' uses the wrapped-native token's logo. */
  async get(chain: ChainConfig, token: Address | 'native'): Promise<string | null> {
    const addr = token === 'native' ? chain.wrappedNative : token;
    return this.cached(KEY(chain.id, addr), () =>
      this.fetchImage(`${CDN}/tokens/${chain.dexscreenerSlug}/${addr.toLowerCase()}.png`),
    );
  }

  /** A chain's own mark, by the name DEX Screener gives the chain. */
  chain(slug: string): Promise<string | null> {
    return this.cached(CHAIN_KEY(slug), () => this.fetchImage(`${CDN}/chains/${slug}.png`));
  }

  /**
   * A Solana token's logo: the image its metadata (`uri`, read from chain) names when that
   * is on IPFS, as it is for coins launched on pump.fun; else DEX Screener's.
   */
  solana(mint: SolAddress, uri: string | null): Promise<string | null> {
    return this.cached(SOL_KEY(mint), async () => {
      const fromMetadata = uri ? await this.ipfsLogo(uri) : null;
      return fromMetadata ?? this.fetchImage(`${CDN}/tokens/solana/${mint}.png`);
    });
  }

  /** The cached logo under `key`, else fetched once however many ask at the same time. */
  private async cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const cached = (await this.local.get(key)) as CachedLogo | undefined;
    if (cached && (cached.url || this.now() - cached.at < RETRY_MISSING_MS)) return cached.url;

    let job = this.inflight.get(key);
    if (!job) {
      job = load()
        .then(async (url) => {
          // Only definite answers are cached ("no logo" included); network errors are not.
          await this.store(key, { url, at: this.now() });
          return url;
        })
        .catch(() => null)
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }

  private store(key: string, entry: CachedLogo): Promise<void> {
    const run = this.queue.then(async () => {
      const index = await this.loadIndex();
      const at = index.findIndex((e) => e.k === key);
      if (at >= 0) index.splice(at, 1);
      index.push({ k: key, n: entry.url?.length ?? 0 });
      await this.evict(index);
      await this.local.set(key, entry);
      await this.local.set(INDEX_KEY, index);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drops the oldest entries until both limits hold. */
  private async evict(index: IndexEntry[]): Promise<void> {
    let chars = index.reduce((s, e) => s + e.n, 0);
    while (index.length > LOGO_CACHE_MAX_ENTRIES || chars > LOGO_CACHE_MAX_CHARS) {
      const old = index.shift();
      if (!old) break;
      chars -= old.n;
      await this.local.remove(old.k);
    }
  }

  private async loadIndex(): Promise<IndexEntry[]> {
    if (this.index) return this.index;
    const stored = await this.local.get(INDEX_KEY);
    if (Array.isArray(stored)) {
      this.index = stored.filter(
        (e): e is IndexEntry => typeof e?.k === 'string' && typeof e?.n === 'number',
      );
      return this.index;
    }
    // First run with a bounded cache: index what earlier versions stored, oldest first.
    const all = (await this.local.getAll?.()) ?? {};
    this.index = Object.entries(all)
      .filter(([k]) => k.startsWith(PREFIX))
      .map(([k, v]) => {
        const c = v as Partial<CachedLogo> | undefined;
        return { k, n: typeof c?.url === 'string' ? c.url.length : 0, at: c?.at ?? 0 };
      })
      .sort((a, b) => a.at - b.at)
      .map(({ k, n }) => ({ k, n }));
    await this.evict(this.index);
    await this.local.set(INDEX_KEY, this.index);
    return this.index;
  }

  /** The image a coin's metadata on IPFS names, scaled down by the gateway; null when none. */
  private async ipfsLogo(uri: string): Promise<string | null> {
    const cid = ipfsCid(uri);
    if (!cid) return null;
    const meta = await this.fetchBytes(`${IPFS_GATEWAY}${cid}`, MAX_JSON_BYTES, (type) =>
      ['application/json', 'text/plain'].includes(type),
    );
    if (!meta) return null;
    let image: unknown;
    try {
      image = (JSON.parse(new TextDecoder().decode(meta.bytes)) as { image?: unknown }).image;
    } catch {
      return null;
    }
    const imageCid = typeof image === 'string' ? ipfsCid(image) : null;
    if (!imageCid) return null;
    return this.fetchImage(`${IPFS_GATEWAY}${imageCid}?img-width=${LOGO_PX}&img-dpr=2`);
  }

  private async fetchImage(url: string): Promise<string | null> {
    const got = await this.fetchBytes(url, MAX_BYTES, (type) => ALLOWED_TYPES.has(type));
    if (!got) return null;
    // Must decode as an image (rejects HTML/JSON served with an image type).
    const bitmap = await createImageBitmap(new Blob([got.bytes], { type: got.type }));
    bitmap.close();
    return `data:${got.type};base64,${toBase64(got.bytes)}`;
  }

  /**
   * The body of `url` when it is found, of an accepted type and at most `max` bytes; null
   * when it is not (a definite answer). Throws on errors worth retrying later.
   */
  private async fetchBytes(
    url: string,
    max: number,
    accept: (type: string) => boolean,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`logo http ${res.status}`); // transient: retry next time
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!accept(type)) return null;
      const bytes = await readCapped(res, max);
      return bytes && bytes.byteLength > 0 ? { bytes, type } : null;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }
}

/** The body, or null as soon as it passes `max` bytes (the rest is never read). */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
