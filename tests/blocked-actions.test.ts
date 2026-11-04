import { describe, expect, it } from 'vitest';
import { handleMessage } from '../src/background/router';
import { TradeError, markRefused } from '../src/background/trade/engine/core';
import {
  readBlockedActions,
  refusedActions,
  type TicketLeg,
  type TradeTicket,
} from '../src/shared/panel';

const ACTIONS = [
  { label: 'Swap on Test curve', ok: true },
  { label: 'Transfer', ok: false, reason: 'Pays an address that is not yours' },
];

describe('decoded actions of a refused transaction', () => {
  it('cross to the website only as plain, short fields', () => {
    expect(readBlockedActions(ACTIONS)).toEqual(ACTIONS);
    expect(
      readBlockedActions([{ label: 'x'.repeat(500), ok: false, reason: 'y'.repeat(500) }]),
    ).toEqual([{ label: 'x'.repeat(200), ok: false, reason: 'y'.repeat(300) }]);
    // Extra fields stay behind.
    expect(readBlockedActions([{ label: 'Swap', ok: true, html: '<b>' }])).toEqual([
      { label: 'Swap', ok: true },
    ]);
    // Anything else drops the whole list, as does an empty or overlong one.
    expect(readBlockedActions([{ label: 'Swap', ok: 'yes' }])).toBeUndefined();
    expect(readBlockedActions([{ label: 1, ok: true }])).toBeUndefined();
    expect(readBlockedActions([{ label: 'Swap', ok: true, reason: 2 }])).toBeUndefined();
    expect(readBlockedActions([null])).toBeUndefined();
    expect(readBlockedActions([])).toBeUndefined();
    expect(readBlockedActions(Array(33).fill(ACTIONS[0]))).toBeUndefined();
    expect(readBlockedActions('Blocked')).toBeUndefined();
  });

  it('block a leg when its signer refused it, and only then', () => {
    const ticket = { status: 'working', legs: [] } as unknown as TradeTicket;
    const leg = { status: 'failed', error: 'timeout' } as unknown as TicketLeg;
    markRefused(ticket, leg, new Error('timeout'));
    expect(leg.status).toBe('failed');
    expect(ticket.blocked).toBeUndefined();

    const refusal = Object.assign(new Error('Pays an address that is not yours'), {
      actions: ACTIONS,
    });
    markRefused(ticket, leg, refusal);
    expect(leg.status).toBe('blocked');
    expect(ticket.blocked).toEqual(ACTIONS);
    expect(refusedActions(null)).toBeUndefined();
    expect(refusedActions('Blocked')).toBeUndefined();
    expect(refusedActions({ actions: [] })).toBeUndefined();
  });

  it('reach the caller with the refusal', async () => {
    const deps = (changePassword: () => Promise<void>) =>
      ({
        vault: { changePassword, isUnlocked: async () => true },
        onActivity: async () => {},
      }) as never;
    const req = { type: 'vault.changePassword', password: 'a', newPassword: 'b' };
    const meta = { kind: 'extension-page' } as const;
    expect(
      await handleMessage(
        req,
        meta,
        deps(async () => {}),
      ),
    ).toEqual({ ok: true, data: null });
    const refused = deps(async () => {
      throw new TradeError('blocked', 'Pays an address that is not yours', ACTIONS);
    });
    expect(await handleMessage(req, meta, refused)).toEqual({
      ok: false,
      error: 'blocked',
      detail: 'Pays an address that is not yours',
      actions: ACTIONS,
    });
    // Without actions the result stays as it was.
    const plain = deps(async () => {
      throw new TradeError('blocked', 'This trade cannot fill right now.');
    });
    expect(await handleMessage(req, meta, plain)).toEqual({
      ok: false,
      error: 'blocked',
      detail: 'This trade cannot fill right now.',
    });
  });
});
