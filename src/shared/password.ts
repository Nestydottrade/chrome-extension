/** The shortest password a new wallet accepts. */
export const MIN_PASSWORD_LENGTH = 10;

/** Something a new wallet password still lacks. */
export type PasswordNeed = 'length' | 'upper' | 'lower' | 'digit';

const HAS = {
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  digit: /\p{N}/u,
} as const;

/** Characters as people count them: an emoji is one, not two. */
export function passwordLength(password: string): number {
  return [...password].length;
}

/**
 * What a new wallet password still lacks, in the order the form names it: at least
 * MIN_PASSWORD_LENGTH characters with an uppercase letter, a lowercase letter and a number.
 * The wallet is encrypted with Argon2id, but a short or plain password can still be guessed
 * offline by anyone who copies the encrypted wallet. Only creating a wallet and changing its
 * password check this; unlocking and exporting take the password it has.
 */
export function passwordNeeds(password: string): PasswordNeed[] {
  const needs: PasswordNeed[] = [];
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) needs.push('length');
  for (const need of ['upper', 'lower', 'digit'] as const) {
    if (!HAS[need].test(password)) needs.push(need);
  }
  return needs;
}
