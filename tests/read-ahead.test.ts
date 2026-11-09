import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { readTokenBalances } from '../src/background/balances';
import { EngineCore, type EngineDeps } from '../src/background/trade/engine/core';
import { READ_AHEAD_FRESH_MS, ReadAhead } from '../src/background/trade/read-ahead';
import { getChain } from '../src/shared/chains';

// Made-up addresses for these tests only.
const TOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const SPENDER = '0x4444444444444444444444444444444444444444';
const ROUTER = '0x5555555555555555555555555555555555555555';
const ROBINHOOD = 4663;
const BASE = 8453;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe('reads made ahead for a sell', () => {
  it('gives a balance back while fresh, and nothing after', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    r.noteBalance(ROBINHOOD, TOKEN, WALLET, 500n, c.now());
    c.tick(READ_AHEAD_FRESH_MS);
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBe(500n);
    c.tick(1);
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBeUndefined();
  });

  it('drops what was read of a wallet once a transaction from it went out or landed', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    r.noteBalance(ROBINHOOD, TOKEN, WALLET, 500n, c.now());
    r.noteBalance(ROBINHOOD, TOKEN, OTHER, 700n, c.now());
    c.tick(100);
    r.moved(ROBINHOOD, WALLET);
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBeUndefined();
    // Another wallet, or the same one on another chain, is untouched.
    expect(r.balance(ROBINHOOD, TOKEN, OTHER)).toBe(700n);
    r.noteBalance(BASE, TOKEN, WALLET, 900n, c.now() - 50);
    expect(r.balance(BASE, TOKEN, WALLET)).toBe(900n);
    // Read again after the move: it counts.
    c.tick(100);
    r.noteBalance(ROBINHOOD, TOKEN, WALLET, 300n, c.now());
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBe(300n);
  });

  it('voids a read that a transaction overtook while the read was out', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    const sentAt = c.now();
    c.tick(200);
    r.moved(ROBINHOOD, WALLET);
    c.tick(200);
    // The answer arrives after the move, but the read was sent before it.
    r.noteBalance(ROBINHOOD, TOKEN, WALLET, 500n, sentAt);
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBeUndefined();
  });

  it('keeps allowances apart by spender, and Permit2 ones apart from the token ones', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    r.noteAllowance(ROBINHOOD, TOKEN, WALLET, SPENDER, 10n, c.now());
    r.notePermit2(
      ROBINHOOD,
      TOKEN,
      WALLET,
      ROUTER,
      { amount: 5n, expiration: 99, nonce: 3 },
      c.now(),
    );
    expect(r.allowance(ROBINHOOD, TOKEN, WALLET, SPENDER)).toBe(10n);
    expect(r.allowance(ROBINHOOD, TOKEN, WALLET, ROUTER)).toBeUndefined();
    expect(r.permit2(ROBINHOOD, TOKEN, WALLET, ROUTER)).toEqual({
      amount: 5n,
      expiration: 99,
      nonce: 3,
    });
    expect(r.permit2(ROBINHOOD, TOKEN, WALLET, SPENDER)).toBeUndefined();
    // A balance is not an allowance.
    expect(r.balance(ROBINHOOD, TOKEN, WALLET)).toBeUndefined();
  });

  it('takes an EVM address in any case as one, and a base58 one as written', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    const token = '0xAbCdEf0000000000000000000000000000000001';
    const wallet = '0xFeDcBa0000000000000000000000000000000002';
    r.noteBalance(ROBINHOOD, token, wallet, 500n, c.now());
    expect(r.balance(ROBINHOOD, token.toLowerCase(), wallet.toLowerCase())).toBe(500n);
    const mint = 'So1anaMintAbc';
    r.noteBalance(101, mint, 'OwnerXyz', 7n, c.now());
    expect(r.balance(101, mint, 'OwnerXyz')).toBe(7n);
    expect(r.balance(101, mint.toLowerCase(), 'ownerxyz')).toBeUndefined();
  });

  it('keeps fresh values when it drops the stale ones', () => {
    const c = clock();
    const r = new ReadAhead(c.now);
    for (let i = 0; i < 450; i++)
      r.noteBalance(ROBINHOOD, `0x${i.toString(16).padStart(40, '0')}`, WALLET, 1n, c.now());
    c.tick(READ_AHEAD_FRESH_MS + 1);
    r.noteBalance(ROBINHOOD, TOKEN, OTHER, 42n, c.now());
    for (let i = 0; i < 450; i++) r.noteBalance(ROBINHOOD, TOKEN, `0x${i}`, 1n, c.now());
    expect(r.balance(ROBINHOOD, TOKEN, OTHER)).toBe(42n);
  });
});

describe('the engine takes a read made ahead', () => {
  it('only while no transaction from the wallet on that chain is still out', () => {
    const c = clock();
    const core = new EngineCore({
      vault: {},
      now: c.now,
      notify: () => undefined,
    } as unknown as EngineDeps);
    const chain = getChain(ROBINHOOD);
    if (!chain) throw new Error('no Robinhood chain');
    const st = core.newTicket('buy', chain, [
      { walletId: 'w1', walletName: 'W1', kind: 'swap', status: 'queued' },
    ]);
    const leg = st.ticket.legs[0];
    if (!leg) throw new Error('no leg');
    expect(core.ahead(ROBINHOOD, 'w1')).toBe(core.readAhead);
    for (const status of ['sending', 'submitted'] as const) {
      leg.status = status;
      expect(core.ahead(ROBINHOOD, 'w1')).toBeNull();
      // Another wallet, or the same wallet on another chain, still may.
      expect(core.ahead(ROBINHOOD, 'w2')).toBe(core.readAhead);
      expect(core.ahead(BASE, 'w1')).toBe(core.readAhead);
    }
    leg.status = 'confirmed';
    expect(core.ahead(ROBINHOOD, 'w1')).toBe(core.readAhead);
  });
});

describe('token balances for the read ahead', () => {
  it('keeps a failed read apart from a zero balance', async () => {
    const client = {
      multicall: async () => [
        { status: 'success', result: 0n },
        { status: 'failure', error: new Error('reverted') },
        { status: 'success', result: 12n },
      ],
    } as unknown as PublicClient;
    expect(await readTokenBalances(client, TOKEN, [WALLET, OTHER, SPENDER])).toEqual([
      0n,
      null,
      12n,
    ]);
    expect(await readTokenBalances(client, TOKEN, [])).toEqual([]);
  });
});
