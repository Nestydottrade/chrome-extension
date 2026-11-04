/** The shortest password a new wallet accepts. */
export const MIN_PASSWORD_LENGTH = 12;

/** Something a new wallet password still lacks. */
export type PasswordNeed = 'length' | 'upper' | 'lower' | 'digit' | 'symbol';

const HAS = {
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  digit: /\p{N}/u,
  // Punctuation and symbols such as ! # $ & and emoji. A space is not one.
  symbol: /[\p{P}\p{S}]/u,
} as const;

/** Characters as people count them: an emoji is one, not two. */
export function passwordLength(password: string): number {
  return [...password].length;
}

/**
 * What a new wallet password still lacks, in the order the form names it: at least
 * MIN_PASSWORD_LENGTH characters with an uppercase letter, a lowercase letter, a number and
 * a symbol. The wallet is encrypted with Argon2id, but a short or plain password can still be
 * guessed offline by anyone who copies the encrypted wallet. Only creating a wallet checks
 * this; unlocking and exporting take the password the wallet was made with.
 */
export function passwordNeeds(password: string): PasswordNeed[] {
  const needs: PasswordNeed[] = [];
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) needs.push('length');
  for (const need of ['upper', 'lower', 'digit', 'symbol'] as const) {
    if (!HAS[need].test(password)) needs.push(need);
  }
  return needs;
}
