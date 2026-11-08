import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES, RequestSchema } from '../src/shared/messages';
import { passwordNeeds } from '../src/shared/password';
import { passwordHint } from '../src/ui/password-hint';

describe('new wallet password', () => {
  it('needs 10 characters with an uppercase letter, a lowercase letter and a number', () => {
    expect(passwordNeeds('')).toEqual(['length', 'upper', 'lower', 'digit']);
    expect(passwordNeeds('Tr0ub4dor')).toEqual(['length']);
    expect(passwordNeeds('tr0ub4dor3')).toEqual(['upper']);
    expect(passwordNeeds('TR0UB4DOR3')).toEqual(['lower']);
    expect(passwordNeeds('Troubadours')).toEqual(['digit']);
    expect(passwordNeeds('Tr0ub4dor3')).toEqual([]);
  });

  it('asks for no symbol, and takes one', () => {
    expect(passwordNeeds('Correct horse battery 9')).toEqual([]);
    expect(passwordNeeds('Tr0ub4dor&3x')).toEqual([]);
  });

  it('takes letters beyond English and counts an emoji as one character', () => {
    expect(passwordNeeds('Ölçü-Şifre-2026')).toEqual([]);
    expect(passwordNeeds('ÖLÇÜ-ŞIFRE-2026')).toEqual(['lower']);
    expect(passwordNeeds('Ab1' + '🥚'.repeat(6))).toEqual(['length']);
    expect(passwordNeeds('Ab1' + '🥚'.repeat(7))).toEqual([]);
  });

  it('names the rule, then only what the password lacks', () => {
    expect(passwordHint('')).toBe(
      'At least 10 characters, with an uppercase letter, a lowercase letter and a number.',
    );
    expect(passwordHint('Tr0ub4dor')).toBe('Add 1 more character.');
    expect(passwordHint('troubadour')).toBe('Add an uppercase letter and a number.');
    expect(passwordHint('Tr0ub4dor3')).toBeUndefined();
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
