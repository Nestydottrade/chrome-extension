import {
  MIN_PASSWORD_LENGTH,
  passwordLength,
  passwordNeeds,
  type PasswordNeed,
} from '../shared/password';

const NEED_TEXT: Record<Exclude<PasswordNeed, 'length'>, string> = {
  upper: 'an uppercase letter',
  lower: 'a lowercase letter',
  digit: 'a number',
};

/** The rule while the field is empty, then only what the password still lacks. */
export function passwordHint(password: string): string | undefined {
  if (!password) {
    return `At least ${MIN_PASSWORD_LENGTH} characters, with an uppercase letter, a lowercase letter and a number.`;
  }
  const parts = passwordNeeds(password).map((need) => {
    if (need !== 'length') return NEED_TEXT[need];
    const more = MIN_PASSWORD_LENGTH - passwordLength(password);
    return `${more} more character${more === 1 ? '' : 's'}`;
  });
  const last = parts.pop();
  if (last === undefined) return undefined;
  return `Add ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}.`;
}
