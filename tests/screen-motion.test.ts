import { describe, expect, it } from 'vitest';
import { screenMotion, type ScreenPlace } from '../src/entrypoints/popup/motion';

const tab = (key: string, index: number): ScreenPlace => ({ key, depth: 0, index });
const sub = (key: string, index: number): ScreenPlace => ({ key, depth: 1, index });

describe('screenMotion', () => {
  it('fades the first screen and a screen that did not change', () => {
    expect(screenMotion(null, tab('wallets', 0))).toBe('fade');
    expect(screenMotion(tab('wallets', 0), tab('wallets', 0))).toBe('fade');
  });

  it('pushes a deeper screen in and pops back out of it', () => {
    expect(screenMotion(tab('wallets', 0), sub('detail:a', 0))).toBe('push');
    expect(screenMotion(sub('detail:a', 0), tab('wallets', 0))).toBe('pop');
  });

  it('slides tabs in bar order', () => {
    expect(screenMotion(tab('wallets', 0), tab('settings', 3))).toBe('next');
    expect(screenMotion(tab('settings', 3), tab('activity', 1))).toBe('prev');
  });

  it('fades between two screens at the same place, such as two tickets', () => {
    expect(screenMotion(sub('ticket:a', 1), sub('ticket:b', 1))).toBe('fade');
  });
});
