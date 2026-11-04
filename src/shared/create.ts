import { hasHiddenChars } from './sanitize';
import type { SolCreateIntent, WireCreateSpec } from './site-bridge';
import { SOLANA_CHAIN_ID } from './solana';

/**
 * Creating a coin from the Nesty website, on the launchpads Nesty trades on that take a
 * new coin straight from the creator's wallet. Each one's rules are its own: read from
 * the factory's verified source (Clanker, Klik, Pons), pump.fun's program and Flap's docs,
 * and run against mainnet (tests/live/create.test.ts). Where a launchpad sets no limit on
 * chain, Nesty's own keeps names short enough for every list to show them whole. Lengths
 * count UTF-8 bytes, as the contracts and the program do.
 */

export type Launchpad = 'pump' | 'flap' | 'clanker' | 'klik' | 'pons';

export interface LaunchpadRules {
  id: Launchpad;
  label: string;
  /** Nesty's chain ids it creates on (Solana's for pump.fun), Nesty's pick first. */
  chains: readonly number[];
  nameMax: number;
  symbolMax: number;
  descriptionMax: number;
  linkMax: number;
  /**
   * Whether the dev buy goes in the creating transaction. Pons takes exactly its fee
   * there, so its dev buy is a second transaction right after (its creator pays no snipe
   * tax on it).
   */
  buyInCreate: boolean;
}

export const LAUNCHPADS: Readonly<Record<Launchpad, LaunchpadRules>> = {
  pump: {
    id: 'pump',
    label: 'pump.fun',
    chains: [SOLANA_CHAIN_ID],
    // create_v2 refuses longer (NameTooLong, SymbolTooLong), measured against mainnet.
    nameMax: 32,
    symbolMax: 13,
    // Off chain, in the metadata JSON: Nesty's limits.
    descriptionMax: 500,
    linkMax: 200,
    buyInCreate: true,
  },
  flap: {
    id: 'flap',
    label: 'Flap',
    chains: [56, 8453, 4663],
    // No limit on chain: Nesty's, short enough for every list to show whole.
    nameMax: 32,
    symbolMax: 10,
    descriptionMax: 500,
    linkMax: 200,
    buyInCreate: true,
  },
  clanker: {
    id: 'clanker',
    label: 'Clanker',
    chains: [8453, 1],
    nameMax: 32,
    symbolMax: 10,
    descriptionMax: 500,
    linkMax: 200,
    buyInCreate: true,
  },
  klik: {
    id: 'klik',
    label: 'Klik',
    chains: [1],
    nameMax: 32,
    symbolMax: 10,
    descriptionMax: 500,
    linkMax: 200,
    buyInCreate: true,
  },
  pons: {
    id: 'pons',
    label: 'Pons',
    chains: [4663],
    // PonsV2LaunchDeployer refuses longer (MetadataTooLong); all of it is kept on chain.
    nameMax: 64,
    symbolMax: 16,
    descriptionMax: 2048,
    linkMax: 256,
    buyInCreate: false,
  },
};

const ORDER: readonly Launchpad[] = ['pump', 'flap', 'clanker', 'klik', 'pons'];

/** The launchpads that create coins on a network, in the order they are offered. */
export function launchpadsOn(chainId: number): LaunchpadRules[] {
  return ORDER.map((id) => LAUNCHPADS[id]).filter((l) => l.chains.includes(chainId));
}

/** pump.fun's limit on a coin's metadata URI (UriTooLong). */
export const PUMP_URI_MAX = 200;
/** Pons keeps the logo's address on chain, up to this many bytes. */
export const PONS_LOGO_MAX = 512;
/** The most metadata JSON Nesty puts on chain for a Clanker coin. */
export const CLANKER_METADATA_MAX = 2048;

/** Images every launchpad shows, small enough to upload quickly. */
export const IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Chains where Flap still launches an untaxed coin to a v2 pool. BSC's now only graduate
 * to PancakeSwap Infinity, which Nesty does not trade; Base never had one.
 */
const FLAP_STANDARD_CHAINS: readonly number[] = [4663];

/** Flap's buy-and-sell tax choices in bps, as its own form offers them; 0 is no tax. */
export function flapTaxes(chainId: number): number[] {
  return [...(FLAP_STANDARD_CHAINS.includes(chainId) ? [0] : []), 100, 300, 500, 1000];
}

/** Pons' creator tax choices in bps, on top of its curve fee (10% at most on chain). */
export const PONS_TAXES: readonly number[] = [0, 100, 200, 500, 1000];

/**
 * The fee Klik's hook profile takes on each trade, in bps: up to `busyExtraBps` more
 * while trading is heavy, and the coin creator's share of all of it. Fixed in the profile
 * for good; tests/live/create.test.ts reads it back from chain.
 */
export const KLIK_FEES = {
  buyBps: 100,
  sellBps: 100,
  busyExtraBps: 100,
  creatorShareBps: 8500,
} as const;

const encoder = new TextEncoder();
export const utf8Bytes = (s: string): number => encoder.encode(s).length;

export type TextField = 'name' | 'symbol' | 'description';

/** Why a coin's name, ticker or description cannot be used as typed, or null. */
export function textProblem(field: TextField, value: string, max: number): string | null {
  if (field !== 'description' && value.length === 0)
    return field === 'name' ? 'Enter a name.' : 'Enter a ticker.';
  if (hasHiddenChars(value, field === 'description')) return 'Remove the hidden characters.';
  if (value !== value.trim()) return 'Remove the spaces at the start or end.';
  if (utf8Bytes(value) > max) return `Too long: ${max} bytes at most.`;
  return null;
}

export type LinkKind = 'website' | 'x' | 'telegram';

const LINK_HOSTS: Partial<Record<LinkKind, readonly string[]>> = {
  x: ['x.com', 'twitter.com'],
  telegram: ['t.me', 'telegram.me'],
};

/** Why a link cannot go on the coin, or null (none is fine). */
export function linkProblem(kind: LinkKind, value: string, max: number): string | null {
  if (value === '') return null;
  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.hostname.includes('.') ||
    hasHiddenChars(value) ||
    /\s/.test(value)
  )
    return 'Enter a full link, starting with https://';
  const hosts = LINK_HOSTS[kind];
  if (hosts && !hosts.includes(url.hostname.replace(/^www\./, '')))
    return kind === 'x' ? 'Use an x.com link.' : 'Use a t.me link.';
  if (utf8Bytes(value) > max) return `Too long: ${max} bytes at most.`;
  return null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
/** An IPFS CID: v0 (Qm…) or v1 in base32 (b…). */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

export const isCid = (s: string): boolean => CID.test(s);

/** An image or metadata address a launchpad shows: ipfs://CID or an https link. */
function refProblem(ref: string, max: number): string | null {
  if (ref.startsWith('ipfs://')) return isCid(ref.slice(7)) ? null : 'Bad IPFS address.';
  return linkProblem('website', ref, max) === null ? null : 'Bad image address.';
}

/** Why the extension may not build this coin on `chainId`, or null. */
export function createSpecProblem(chainId: number, spec: WireCreateSpec): string | null {
  const rules = LAUNCHPADS[spec.launchpad];
  if (!rules.chains.includes(chainId)) return `${rules.label} does not create coins here.`;
  const text =
    textProblem('name', spec.name, rules.nameMax) ??
    textProblem('symbol', spec.symbol, rules.symbolMax);
  if (text) return text;
  if (!HEX32.test(spec.salt)) return 'Bad salt.';
  switch (spec.launchpad) {
    case 'flap':
      if (!flapTaxes(chainId).includes(spec.taxBps)) return 'Flap does not take this tax.';
      return isCid(spec.meta) ? null : 'Bad metadata address.';
    case 'clanker':
      return (
        refProblem(spec.image, 512) ??
        (utf8Bytes(spec.metadata) > CLANKER_METADATA_MAX ? 'Its details are too long.' : null)
      );
    case 'klik':
      return spec.metadata.startsWith('ipfs://')
        ? refProblem(spec.metadata, 512)
        : 'Bad IPFS address.';
    case 'pons':
      if (!PONS_TAXES.includes(spec.creatorTaxBps)) return 'Pons does not take this tax.';
      return (
        (spec.logo === '' ? null : refProblem(spec.logo, PONS_LOGO_MAX)) ??
        textProblem('description', spec.description, rules.descriptionMax) ??
        linkProblem('x', spec.links.twitter, rules.linkMax) ??
        linkProblem('telegram', spec.links.telegram, rules.linkMax) ??
        linkProblem('website', spec.links.website, rules.linkMax)
      );
  }
}

/** Why the extension may not build this pump.fun coin, or null. */
export function createIntentProblem(intent: SolCreateIntent): string | null {
  const rules = LAUNCHPADS.pump;
  return (
    textProblem('name', intent.name, rules.nameMax) ??
    textProblem('symbol', intent.symbol, rules.symbolMax) ??
    (utf8Bytes(intent.uri) > PUMP_URI_MAX ? 'Its metadata address is too long.' : null) ??
    refProblem(intent.uri, PUMP_URI_MAX)
  );
}
