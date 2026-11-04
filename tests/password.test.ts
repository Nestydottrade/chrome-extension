import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES, RequestSchema } from '../src/shared/messages';
import { passwordNeeds } from '../src/shared/password';

describe('new wallet password', () => {
  it('needs 12 characters with an uppercase letter, a lowercase letter, a number and a symbol', () => {
    expect(passwordNeeds('')).toEqual(['length', 'upper', 'lower', 'digit', 'symbol']);
    expect(passwordNeeds('Tr0ub4d!')).toEqual(['length']);
    expect(passwordNeeds('tr0ub4dor&3x')).toEqual(['upper']);
    expect(passwordNeeds('TR0UB4DOR&3X')).toEqual(['lower']);
    expect(passwordNeeds('Troubadour&xx')).toEqual(['digit']);
    expect(passwordNeeds('Troubador3xx')).toEqual(['symbol']);
    expect(passwordNeeds('Tr0ub4dor&3x')).toEqual([]);
  });

  it('does not count a space as a symbol', () => {
    expect(passwordNeeds('Correct horse battery 9')).toEqual(['symbol']);
    expect(passwordNeeds('Correct horse battery 9!')).toEqual([]);
  });

  it('takes letters beyond English and counts an emoji as one character', () => {
    expect(passwordNeeds('Ölçü-Şifre-2026')).toEqual([]);
    expect(passwordNeeds('ÖLÇÜ-ŞIFRE-2026')).toEqual(['lower']);
    expect(passwordNeeds('Ab1' + '🥚'.repeat(8))).toEqual(['length']);
    expect(passwordNeeds('Ab1' + '🥚'.repeat(9))).toEqual([]);
  });
});

describe('panel position messages', () => {
  it('are open to content scripts and carry no site field', () => {
    expect(CONTENT_TYPES.has('panel.getPrefs')).toBe(true);
    expect(CONTENT_TYPES.has('panel.setPrefs')).toBe(true);
    const prefs = { x: 12.5, y: 80, minimized: false, hidden: true };
    expect(RequestSchema.safeParse({ type: 'panel.setPrefs', prefs }).success).toBe(true);
    // The site is the sender's origin: a field naming another one is refused.
    expect(
      RequestSchema.safeParse({ type: 'panel.setPrefs', prefs, host: 'gmgn.ai' }).success,
    ).toBe(false);
    expect(
      RequestSchema.safeParse({ type: 'panel.setPrefs', prefs: { ...prefs, x: Infinity } }).success,
    ).toBe(false);
  });
});
