import { browser } from 'wxt/browser';
import {
  ResultEnvelopeSchema,
  type ErrorCode,
  type RequestOf,
  type RequestType,
  type ResponseMap,
  type Result,
} from '../shared/messages';
import { MIN_PASSWORD_LENGTH } from '../shared/password';
import { extensionAlive } from './runtime';

/** Typed request to the background. Never throws; transport errors become 'internal'. */
export async function send<T extends RequestType>(
  req: RequestOf<T>,
): Promise<Result<ResponseMap[T]>> {
  try {
    const raw: unknown = await browser.runtime.sendMessage(req);
    const env = ResultEnvelopeSchema.safeParse(raw);
    if (!env.success) return { ok: false, error: 'internal' };
    return env.data as Result<ResponseMap[T]>;
  } catch {
    // On a page (the panel's), Nesty may have been updated since the page loaded.
    return { ok: false, error: extensionAlive() ? 'internal' : 'reloaded' };
  }
}

const MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'Invalid request.',
  forbidden: 'Not allowed from here.',
  internal: 'Something went wrong. Try again.',
  no_vault: 'No wallet set up yet.',
  exists: 'A wallet already exists.',
  locked: 'Wallet is locked.',
  bad_password: 'Wrong password.',
  weak_password: `Password needs at least ${MIN_PASSWORD_LENGTH} characters, with an uppercase letter, a lowercase letter and a number.`,
  bad_mnemonic: 'That recovery phrase is not valid (12 or 24 English words).',
  bad_private_key: 'That private key is not valid.',
  duplicate: 'This wallet is already in Nesty.',
  not_found: 'Wallet not found.',
  primary: 'Not possible for the default wallet. Make another wallet the default first.',
  limit: 'Wallet limit reached.',
  too_many_attempts: 'Too many attempts.',
  corrupt: 'Wallet data is damaged. Restore from your recovery phrase.',
  no_solana: 'This wallet was imported from an EVM key, so it has no Solana address.',
  no_evm: 'This wallet was imported from a Solana key, so it has no EVM address.',
  unsupported_chain: 'This chain is not supported.',
  no_route: 'No liquidity found for this token.',
  needs_confirmation: 'Confirm this trade.',
  needs_password: 'Enter your password to send this.',
  limit_exceeded: 'Above your safety limit. Raise it in Settings to continue.',
  tax_too_high: 'Token tax is above your Max tax.',
  insufficient_funds: 'Insufficient balance.',
  blocked: 'Transaction blocked by the safety check.',
  rpc: 'Network error. Check your RPC and try again.',
  permission_denied: 'Permission was not granted.',
  invalid_settings: 'Not saved.',
  not_connected: 'Connect this site to Nesty first.',
  rejected: 'Declined in Nesty.',
  too_many_alerts: 'Nesty keeps up to 50 price alerts. Remove one to set another.',
  too_many_wallets: 'Nesty follows up to 20 wallets. Unfollow one to add another.',
  reloaded: 'Nesty was updated. Reload this page to keep using it.',
};

export function errorText(res: {
  error: ErrorCode;
  retryAfterMs?: number;
  detail?: string;
}): string {
  if (res.error === 'too_many_attempts' && res.retryAfterMs) {
    return `Too many attempts. Try again in ${Math.ceil(res.retryAfterMs / 1000)} s.`;
  }
  const base = MESSAGES[res.error] ?? MESSAGES.internal;
  // `detail` is produced by the background from our own strings, never from token data.
  return res.detail ? `${base} ${res.detail}` : base;
}
