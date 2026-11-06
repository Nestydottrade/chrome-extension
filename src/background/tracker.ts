import { alertSlug } from '../shared/alerts';
import { getChain, type ChainConfig } from '../shared/chains';
import { sanitizeLabel } from '../shared/sanitize';
import { SOLANA_CHAIN_ID, isSolana } from '../shared/solana';
import {
  MAX_FOLLOWED,
  TRADES_KEPT,
  TRADES_PER_WALLET,
  TRADE_TTL_MS,
  shortAddress,
  walletName,
  walletOf,
  type FollowEdit,
  type FollowInput,
  type FollowedWallet,
  type TrackedTrade,
  type TrackerView,
} from '../shared/tracker';
import { WSOL_MINT } from './solana/address';
import { trackNoteId, tradeText } from './tracker-notes';
import {
  coinsFromFeed,
  evmMoves,
  evmTrade,
  solTrade,
  type EvmLog,
  type FeedCoin,
  type ParsedTrade,
  type SolTxJson,
} from './tracker-parse';

const WALLETS_KEY = 'nesty.tracker.wallets';
const STATE_KEY = 'nesty.tracker.state';
/** Up to 30 coins of one chain per request. */
const FEED = 'https://api.dexscreener.com/tokens/v1';
const BATCH = 30;
/** A Solana wallet's first look: its latest transactions, shown but never notified. */
const SOL_FIRST = 12;
/** After that: the signatures asked for, and the transactions read, per check. */
const SOL_NEXT = 25;
const SOL_READ = 8;
/** A transaction the node does not have this long after its block is passed over. */
const SOL_WAIT_MS = 2 * 60_000;
/** EVM transactions read per wallet per check: the newest, when it sent more. */
const EVM_TX_PER_WALLET = 5;
/** An EVM wallet unread for longer starts again at the newest block: the gap is not read. */
const EVM_GAP_MS = 10 * 60_000;
const EVM_GAP_BLOCKS = 5_000n;
/** At most this many notifications per check, none for a trade older than NOTE_MAX_AGE_MS. */
const NOTES_PER_CHECK = 5;
const NOTE_MAX_AGE_MS = 10 * 60_000;
/** The site's feed starts a check when the last one began at least this long ago. */
const FEED_CHECK_MS = 15_000;

export class TrackerError extends Error {
  constructor(readonly code: 'too_many_wallets' | 'invalid_request') {
    super(code);
    this.name = 'TrackerError';
  }
}

export interface SolSignature {
  sig: string;
  failed: boolean;
  /** Its block's time; null when the node does not say. */
  at: number | null;
}

export interface SolReader {
  /** The latest signatures that touched `address`, newest first, back to (not including) `until`. */
  signatures(address: string, limit: number, until: string | null): Promise<SolSignature[]>;
  /** A landed transaction; null when the node does not have it yet. */
  transaction(sig: string): Promise<SolTxJson | null>;
}

export interface EvmTx {
  hash: string;
  /** Lower case. */
  from: string;
  value: bigint;
}

export interface EvmReceipt {
  ok: boolean;
  /** Every fee the sender paid, in wei (an OP chain's L1 fee too). */
  fee: bigint;
  logs: EvmLog[];
}

export interface EvmReader {
  head(): Promise<bigint>;
  /** Native balances at `block`, in one request; null where one failed. */
  balances(addresses: readonly string[], block: bigint): Promise<(bigint | null)[]>;
  /** Transactions `address` had sent by the end of `block`. */
  nonce(address: string, block: bigint): Promise<number>;
  block(block: bigint): Promise<{ at: number; txs: EvmTx[] }>;
  receipt(hash: string): Promise<EvmReceipt | null>;
  decimals(token: string): Promise<number | null>;
  symbol(token: string): Promise<string | null>;
}

export interface TrackerDeps {
  local: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  fetchJson: (url: string) => Promise<unknown>;
  /** Shows a notification with buttons; its id comes back when it or a button is clicked. */
  notify: (id: string, title: string, message: string, buttons: string[]) => Promise<void>;
  /** The browser does not show this extension's notifications. */
  blocked: () => Promise<boolean>;
  /** Keeps the wallets read on a timer while any is followed, and stops it when none is. */
  schedule: (on: boolean) => Promise<void>;
  sol: () => Promise<SolReader>;
  /** Null for a chain that cannot be read. */
  evm: (chainId: number) => Promise<EvmReader | null>;
  /** The EVM chains a followed EVM wallet is watched on. */
  evmChains: () => readonly number[];
  newId: () => string;
  now: () => number;
}

/** The newest signature read; null for a wallet with none yet. */
interface SolCursor {
  sig: string | null;
  at: number;
}

/** The block a wallet was last read at, with its balance and sent count then. */
interface EvmCursor {
  block: string;
  balance: string;
  nonce: number;
  at: number;
}

interface TrackerState {
  /** `sol:<address>` or `evm:<chainId>:<address>`. */
  cursors: Record<string, SolCursor | EvmCursor>;
  /** Newest first. */
  trades: TrackedTrade[];
  /** Per site. */
  minUsd: Record<string, number>;
  checkedAt: number | null;
}

const isWallet = (v: unknown): v is FollowedWallet => {
  const w = v as Partial<FollowedWallet> | null;
  return (
    typeof w?.id === 'string' &&
    typeof w.origin === 'string' &&
    (w.kind === 'solana' || w.kind === 'evm') &&
    typeof w.address === 'string' &&
    typeof w.name === 'string' &&
    typeof w.alerts === 'boolean' &&
    typeof w.at === 'number'
  );
};

const isTrade = (v: unknown): v is TrackedTrade => {
  const t = v as Partial<TrackedTrade> | null;
  const num = (n: unknown) => n === null || typeof n === 'number';
  return (
    typeof t?.id === 'string' &&
    typeof t.wallet === 'string' &&
    typeof t.chainId === 'number' &&
    typeof t.hash === 'string' &&
    typeof t.at === 'number' &&
    (t.side === 'buy' || t.side === 'sell') &&
    typeof t.token === 'string' &&
    typeof t.tokens === 'number' &&
    num(t.native) &&
    num(t.usd) &&
    (t.symbol === null || typeof t.symbol === 'string') &&
    num(t.mcap)
  );
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readState(v: unknown): TrackerState {
  const s = isObject(v) ? v : {};
  return {
    cursors: isObject(s.cursors) ? (s.cursors as TrackerState['cursors']) : {},
    trades: Array.isArray(s.trades) ? s.trades.filter(isTrade) : [],
    minUsd: isObject(s.minUsd) ? (s.minUsd as TrackerState['minUsd']) : {},
    checkedAt: typeof s.checkedAt === 'number' ? s.checkedAt : null,
  };
}

/** The wallet a cursor key is for. */
const cursorWallet = (key: string) => key.slice(key.lastIndexOf(':') + 1);

/** Newest first, none past their time, at most TRADES_PER_WALLET per wallet and TRADES_KEPT in all. */
function prune(trades: readonly TrackedTrade[], now: number): TrackedTrade[] {
  const per = new Map<string, number>();
  const out: TrackedTrade[] = [];
  for (const t of [...trades].sort((a, b) => b.at - a.at)) {
    if (now - t.at > TRADE_TTL_MS) continue;
    const n = per.get(t.wallet) ?? 0;
    if (n >= TRADES_PER_WALLET) continue;
    per.set(t.wallet, n + 1);
    out.push(t);
    if (out.length >= TRADES_KEPT) break;
  }
  return out;
}

/**
 * Keeps the wallets the site follows and reads their trades, every 30 seconds while the
 * browser runs (an alarm wakes the worker for it), and every 15 while the site's Tracker
 * is open. A new trade of a wallet with alerts on shows a notification.
 */
export class TrackerWatcher {
  private list: FollowedWallet[] | null = null;
  private st: TrackerState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | null = null;
  private again = false;
  private startedAt = 0;
  /** `${chainId}:${token}` → decimals: they never change. */
  private readonly decimals = new Map<string, number>();
  /** `${chainId}:${token}` → symbol, as the coin itself says. */
  private readonly symbols = new Map<string, string>();

  constructor(private readonly d: TrackerDeps) {}

  private async wallets(): Promise<FollowedWallet[]> {
    if (!this.list) {
      const v = await this.d.local.get(WALLETS_KEY);
      this.list = Array.isArray(v) ? v.filter(isWallet) : [];
    }
    return this.list;
  }

  private async state(): Promise<TrackerState> {
    this.st ??= readState(await this.d.local.get(STATE_KEY));
    return this.st;
  }

  /** Runs one read-modify-write at a time. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Only inside enqueue. The timer runs while any wallet is followed. */
  private async saveWallets(before: FollowedWallet[], next: FollowedWallet[]): Promise<void> {
    this.list = next;
    await this.d.local.set(WALLETS_KEY, next);
    if (before.length > 0 !== next.length > 0)
      await this.d.schedule(next.length > 0).catch(() => undefined);
  }

  /** Only inside enqueue. */
  private async saveState(next: TrackerState): Promise<void> {
    this.st = next;
    await this.d.local.set(STATE_KEY, next);
  }

  private async view(origin: string): Promise<TrackerView> {
    const [list, st, blocked] = await Promise.all([
      this.wallets(),
      this.state(),
      this.d.blocked().catch(() => false),
    ]);
    const mine = list.filter((w) => w.origin === origin);
    const followed = new Set(mine.map((w) => w.address));
    return {
      wallets: mine.map((w) => ({
        id: w.id,
        kind: w.kind,
        address: w.address,
        name: w.name,
        alerts: w.alerts,
        at: w.at,
      })),
      trades: st.trades.filter((t) => followed.has(t.wallet)),
      minUsd: st.minUsd[origin] ?? 0,
      blocked,
      checkedAt: st.checkedAt,
    };
  }

  /** When the worker starts: the timer runs while wallets are followed, and they are read. */
  async start(): Promise<void> {
    const list = await this.wallets();
    await this.d.schedule(list.length > 0);
    if (list.length > 0) await this.check();
  }

  /** What the site's Tracker shows. Asked for while it is open, it also reads the wallets again. */
  async feed(origin: string): Promise<TrackerView> {
    const follows = (await this.wallets()).some((w) => w.origin === origin);
    if (follows && this.d.now() - this.startedAt >= FEED_CHECK_MS)
      void this.check().catch(() => undefined);
    return this.view(origin);
  }

  async follow(origin: string, input: FollowInput): Promise<TrackerView> {
    const w = walletOf(input.address);
    if (!w) throw new TrackerError('invalid_request');
    const name = walletName(input.name);
    let full = false;
    await this.enqueue(async () => {
      const before = await this.wallets();
      // The same wallet twice (a double click) is kept once; a name given renames it.
      const twin = before.find((x) => x.origin === origin && x.address === w.address);
      if (twin) {
        if (name && name !== twin.name)
          await this.saveWallets(
            before,
            before.map((x) => (x === twin ? { ...x, name } : x)),
          );
        return;
      }
      if (before.length >= MAX_FOLLOWED) {
        full = true;
        return;
      }
      const wallet: FollowedWallet = {
        id: this.d.newId(),
        origin,
        kind: w.kind,
        address: w.address,
        name,
        alerts: true,
        at: this.d.now(),
      };
      await this.saveWallets(before, [...before, wallet]);
    });
    if (full) throw new TrackerError('too_many_wallets');
    // Read now: a Solana wallet's latest trades show at once.
    void this.check().catch(() => undefined);
    return this.view(origin);
  }

  async unfollow(origin: string, id: string): Promise<TrackerView> {
    await this.enqueue(async () => {
      const before = await this.wallets();
      const next = before.filter((w) => !(w.id === id && w.origin === origin));
      if (next.length !== before.length) await this.saveWallets(before, next);
    });
    return this.view(origin);
  }

  async edit(origin: string, e: FollowEdit): Promise<TrackerView> {
    const name = e.name === undefined ? undefined : walletName(e.name);
    await this.enqueue(async () => {
      const before = await this.wallets();
      const next = before.map((w) =>
        w.id === e.id && w.origin === origin
          ? { ...w, name: name ?? w.name, alerts: e.alerts ?? w.alerts }
          : w,
      );
      await this.saveWallets(before, next);
    });
    return this.view(origin);
  }

  /** A notification's Mute button: that wallet's trades stop notifying. */
  async mute(origin: string, id: string): Promise<void> {
    await this.edit(origin, { id, alerts: false });
  }

  async setMinUsd(origin: string, minUsd: number): Promise<TrackerView> {
    if (!Number.isFinite(minUsd) || minUsd < 0) throw new TrackerError('invalid_request');
    await this.enqueue(async () => {
      const st = await this.state();
      await this.saveState({ ...st, minUsd: { ...st.minUsd, [origin]: minUsd } });
    });
    return this.view(origin);
  }

  /** Every wallet a site follows: when it is disconnected. */
  async removeSite(origin: string): Promise<void> {
    await this.enqueue(async () => {
      const before = await this.wallets();
      const next = before.filter((w) => w.origin !== origin);
      if (next.length !== before.length) await this.saveWallets(before, next);
      const st = await this.state();
      if (origin in st.minUsd) {
        const minUsd = Object.fromEntries(Object.entries(st.minUsd).filter(([o]) => o !== origin));
        await this.saveState({ ...st, minUsd });
      }
    });
  }

  /** Reads the wallets and notifies their new trades. Asked for during a check, another follows it. */
  check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again);
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private async run(): Promise<void> {
    this.startedAt = this.d.now();
    const list = await this.wallets();
    const before = await this.state();
    const sols = [...new Set(list.filter((w) => w.kind === 'solana').map((w) => w.address))];
    const evms = [...new Set(list.filter((w) => w.kind === 'evm').map((w) => w.address))];
    /** null: forget it, so the wallet is looked at afresh. */
    const cursors: Record<string, SolCursor | EvmCursor | null> = {};
    const found: TrackedTrade[] = [];
    /** A wallet's first look: shown, never notified. */
    const quiet = new Set<string>();

    if (sols.length > 0) {
      const reader = await this.d.sol().catch(() => null);
      for (const address of reader ? sols : []) {
        const key = `sol:${address}`;
        const cur = before.cursors[key] as SolCursor | undefined;
        try {
          const r = await this.readSol(reader as SolReader, address, cur);
          cursors[key] = r.cursor;
          found.push(...r.trades);
          if (!cur) for (const t of r.trades) quiet.add(t.id);
        } catch {
          // Asked again next time.
        }
      }
    }
    if (evms.length > 0) {
      await Promise.all(
        this.d.evmChains().map(async (chainId) => {
          try {
            const reader = await this.d.evm(chainId);
            if (!reader) return;
            const r = await this.readEvm(chainId, reader, evms, before.cursors);
            Object.assign(cursors, r.cursors);
            found.push(...r.trades);
          } catch {
            // This chain is asked again next time.
          }
        }),
      );
    }

    const now = this.d.now();
    let fresh: TrackedTrade[] = [];
    await this.enqueue(async () => {
      const st = await this.state();
      const followed = new Set((await this.wallets()).map((w) => w.address));
      const next = new Map(Object.entries(st.cursors));
      for (const [k, c] of Object.entries(cursors)) {
        if (c) next.set(k, c);
        else next.delete(k);
      }
      // Wallets no longer followed are forgotten.
      for (const k of [...next.keys()]) if (!followed.has(cursorWallet(k))) next.delete(k);
      const known = new Set(st.trades.map((t) => t.id));
      fresh = found.filter((t) => !known.has(t.id) && followed.has(t.wallet));
      const trades = prune([...fresh, ...st.trades.filter((t) => followed.has(t.wallet))], now);
      await this.saveState({ ...st, cursors: Object.fromEntries(next), trades, checkedAt: now });
    });
    if (fresh.length === 0) return;

    const filled = await this.fill(fresh);
    const byId = new Map(filled.map((t) => [t.id, t]));
    await this.enqueue(async () => {
      const st = await this.state();
      await this.saveState({ ...st, trades: st.trades.map((t) => byId.get(t.id) ?? t) });
    });
    await this.notifyAll(
      filled.filter((t) => !quiet.has(t.id)),
      now,
    );
  }

  private trade(
    chainId: number,
    wallet: string,
    hash: string,
    at: number,
    p: ParsedTrade,
    decimals: number,
    nativeDecimals: number,
  ): TrackedTrade {
    return {
      id: `${chainId}:${hash}`,
      wallet,
      chainId,
      hash,
      at,
      side: p.side,
      token: p.token,
      tokens: Number(p.raw) / 10 ** decimals,
      native: p.native === null ? null : Number(p.native) / 10 ** nativeDecimals,
      usd: p.stableUsd,
      symbol: null,
      mcap: null,
    };
  }

  /**
   * A Solana wallet's transactions since the last look, oldest first. One that cannot be
   * read yet stops the reading there, to be read again next time.
   */
  private async readSol(
    reader: SolReader,
    address: string,
    cur: SolCursor | undefined,
  ): Promise<{ cursor: SolCursor; trades: TrackedTrade[] }> {
    const first = cur === undefined;
    const limit = first ? SOL_FIRST : SOL_NEXT;
    const read = first ? SOL_FIRST : SOL_READ;
    const sigs = await reader.signatures(address, limit, cur?.sig ?? null);
    // More than are read: the older ones are passed over.
    let last = sigs[read]?.sig ?? cur?.sig ?? null;
    const trades: TrackedTrade[] = [];
    for (const s of sigs.slice(0, read).reverse()) {
      if (!s.failed) {
        let tx: SolTxJson | null;
        try {
          tx = await reader.transaction(s.sig);
        } catch (e) {
          // A refusal (a rate limit): read again next time; a first look is made again whole.
          if (first) throw e;
          break;
        }
        if (tx) {
          const p = solTrade(tx, address);
          const at =
            typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : (s.at ?? this.d.now());
          if (p)
            trades.push(this.trade(SOLANA_CHAIN_ID, address, s.sig, at, p, p.decimals ?? 0, 9));
        } else if (!first && (s.at === null || this.d.now() - s.at < SOL_WAIT_MS)) {
          // Too new for the node yet: read again next time. One it never has is passed over.
          break;
        }
      }
      last = s.sig;
    }
    return { cursor: { sig: last, at: this.d.now() }, trades };
  }

  /**
   * The EVM wallets' new transactions on one chain. One request reads every balance; only a
   * wallet whose balance moved is asked how many transactions it has sent, and only one that
   * sent more is looked into: the block of each new one is found by its sent count.
   *
   * Private RPC: the search reads balances and sent counts at past blocks. BNB Chain's own
   * nodes keep only about 128 blocks of state; the next public RPC answers today
   * (docs/private-rpc.md).
   *
   * Private RPC: a trade another account sent for the wallet (a bot, a smart account's
   * bundler) moves neither its sent count nor, often, its balance, so it is not seen. Finding
   * one takes coin transfers by wallet, which most public RPCs refuse (docs/private-rpc.md).
   */
  private async readEvm(
    chainId: number,
    reader: EvmReader,
    addresses: readonly string[],
    cursors: TrackerState['cursors'],
  ): Promise<{ cursors: Record<string, EvmCursor | null>; trades: TrackedTrade[] }> {
    const chain = getChain(chainId);
    if (!chain) return { cursors: {}, trades: [] };
    const head = await reader.head();
    const balances = await reader.balances(addresses, head);
    const now = this.d.now();
    const out: Record<string, EvmCursor | null> = {};
    const trades: TrackedTrade[] = [];
    for (const [i, address] of addresses.entries()) {
      const key = `evm:${chainId}:${address}`;
      const cur = cursors[key] as EvmCursor | undefined;
      const balance = balances[i];
      if (typeof balance !== 'bigint') continue;
      try {
        const from = cur ? BigInt(cur.block) : null;
        if (cur && from !== null && head <= from) continue;
        if (!cur || from === null || now - cur.at > EVM_GAP_MS || head - from > EVM_GAP_BLOCKS) {
          const nonce = await reader.nonce(address, head);
          out[key] = { block: String(head), balance: String(balance), nonce, at: now };
          continue;
        }
        if (String(balance) === cur.balance) {
          out[key] = { ...cur, block: String(head), at: now };
          continue;
        }
        const nonce = await reader.nonce(address, head);
        if (nonce > cur.nonce)
          trades.push(...(await this.evmTxs(chain, reader, address, from, head, cur.nonce, nonce)));
        out[key] = { block: String(head), balance: String(balance), nonce, at: now };
      } catch {
        // State the node no longer keeps, or a refusal: looked at afresh next time.
        out[key] = null;
      }
    }
    return { cursors: out, trades };
  }

  /** The trades among the transactions `address` sent after block `from`. */
  private async evmTxs(
    chain: ChainConfig,
    reader: EvmReader,
    address: string,
    from: bigint,
    head: bigint,
    fromNonce: number,
    toNonce: number,
  ): Promise<TrackedTrade[]> {
    const out: TrackedTrade[] = [];
    let lo = from;
    // When it sent many, only the newest.
    let seen = Math.max(fromNonce, toNonce - EVM_TX_PER_WALLET);
    for (let round = 0; seen < toNonce && round < EVM_TX_PER_WALLET; round++) {
      // The first block after `lo` by whose end it had sent more than `seen`.
      let a = lo;
      let b = head;
      while (b - a > 1n) {
        const mid = a + (b - a) / 2n;
        if ((await reader.nonce(address, mid)) > seen) b = mid;
        else a = mid;
      }
      const [blk, after] = await Promise.all([reader.block(b), reader.nonce(address, b)]);
      const mine = blk.txs.filter((t) => t.from === address);
      out.push(...(await this.evmBlock(chain, reader, address, b, mine, blk.at)));
      if (after <= seen) break;
      seen = after;
      lo = b;
    }
    return out;
  }

  /** The trades among the transactions `address` sent in one block. */
  private async evmBlock(
    chain: ChainConfig,
    reader: EvmReader,
    address: string,
    block: bigint,
    mine: readonly EvmTx[],
    at: number,
  ): Promise<TrackedTrade[]> {
    const sent = await Promise.all(
      mine.map(async (t) => {
        const receipt = await reader.receipt(t.hash);
        const logs = receipt?.ok ? receipt.logs : [];
        return { t, receipt, logs, moves: evmMoves(logs, address) };
      }),
    );
    const moved = sent.filter((s) => s.moves.size > 0);
    // With coins moved in two of them, the balance cannot tell their payments apart.
    const only = moved.length === 1 ? moved[0]?.t : undefined;
    const delta = only ? await this.blockDelta(reader, address, block, sent, only) : null;
    const out: TrackedTrade[] = [];
    for (const { t, logs, moves } of moved) {
      const p = evmTrade(chain, moves, delta ?? (t.value > 0n ? -t.value : null), logs);
      if (!p) continue;
      const decimals = await this.decimalsOf(chain.id, p.token, reader);
      if (decimals === null) continue;
      const native = chain.nativeCurrency.decimals;
      const symbol = await this.symbolOf(chain.id, p.token, reader);
      out.push({ ...this.trade(chain.id, address, t.hash, at, p, decimals, native), symbol });
    }
    return out;
  }

  /**
   * What the transaction `t` paid or got in the chain's coin: the wallet's balance across
   * the block, with every fee given back and what its other transactions there sent. Bots
   * send an approval right before a sale, in the same block. Null when it cannot be read.
   */
  private async blockDelta(
    reader: EvmReader,
    address: string,
    block: bigint,
    sent: readonly { t: EvmTx; receipt: EvmReceipt | null }[],
    t: EvmTx,
  ): Promise<bigint | null> {
    let spent = 0n;
    for (const s of sent) {
      if (!s.receipt) return null;
      spent += s.receipt.fee + (s.t !== t && s.receipt.ok ? s.t.value : 0n);
    }
    const [[after], [prior]] = await Promise.all([
      reader.balances([address], block),
      reader.balances([address], block - 1n),
    ]);
    if (typeof after !== 'bigint' || typeof prior !== 'bigint') return null;
    return after - prior + spent;
  }

  private async decimalsOf(
    chainId: number,
    token: string,
    reader: EvmReader,
  ): Promise<number | null> {
    const key = `${chainId}:${token}`;
    const known = this.decimals.get(key);
    if (known !== undefined) return known;
    const d = await reader.decimals(token).catch(() => null);
    if (d === null || !Number.isInteger(d) || d < 0 || d > 36) return null;
    this.decimals.set(key, d);
    return d;
  }

  /** The coin's own symbol: the price feed knows few coins still on a curve. */
  private async symbolOf(
    chainId: number,
    token: string,
    reader: EvmReader,
  ): Promise<string | null> {
    const key = `${chainId}:${token}`;
    const known = this.symbols.get(key);
    if (known !== undefined) return known;
    const symbol = sanitizeLabel(await reader.symbol(token).catch(() => null), 16);
    if (!symbol) return null;
    this.symbols.set(key, symbol);
    return symbol;
  }

  /** New trades with their coin's symbol, their USD value then and the market cap at their price. */
  private async fill(trades: readonly TrackedTrade[]): Promise<TrackedTrade[]> {
    const byChain = new Map<number, TrackedTrade[]>();
    for (const t of trades) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t]);
    const out: TrackedTrade[] = [];
    await Promise.all(
      [...byChain].map(async ([chainId, list]) => {
        const slug = alertSlug(chainId);
        // The chain's coin, for what a trade paid in it was worth.
        const ref = isSolana(chainId) ? WSOL_MINT : getChain(chainId)?.wrappedNative.toLowerCase();
        const tokens = [...new Set([...(ref ? [ref] : []), ...list.map((t) => t.token)])];
        const coins = new Map<string, FeedCoin>();
        for (let i = 0; slug && i < tokens.length; i += BATCH) {
          const batch = tokens.slice(i, i + BATCH);
          const json = await this.d
            .fetchJson(`${FEED}/${slug}/${batch.join(',')}`)
            .catch(() => null);
          for (const [t, c] of coinsFromFeed(chainId, batch, json)) coins.set(t, c);
        }
        const nativeUsd = ref ? coins.get(ref)?.priceUsd : undefined;
        for (const t of list) {
          const c = coins.get(t.token);
          const usd = t.usd ?? (t.native !== null && nativeUsd ? t.native * nativeUsd : null);
          const mcap =
            c?.mcap && usd !== null && t.tokens > 0
              ? (usd / t.tokens) * (c.mcap / c.priceUsd)
              : null;
          out.push({ ...t, symbol: c?.symbol ?? t.symbol, usd, mcap });
        }
      }),
    );
    return out;
  }

  /** Oldest first, each to the first site that follows its wallet with alerts on, above its minimum. */
  private async notifyAll(trades: readonly TrackedTrade[], now: number): Promise<void> {
    const list = await this.wallets();
    const { minUsd } = await this.state();
    let sent = 0;
    for (const t of [...trades].sort((a, b) => a.at - b.at)) {
      if (sent >= NOTES_PER_CHECK) break;
      if (now - t.at > NOTE_MAX_AGE_MS) continue;
      const w = list.find(
        (x) =>
          x.address === t.wallet &&
          x.alerts &&
          (t.usd === null || t.usd >= (minUsd[x.origin] ?? 0)),
      );
      if (!w) continue;
      const { title, message } = tradeText(w, t);
      const mute = `Mute ${w.name || shortAddress(w.address)}`;
      await this.d
        .notify(trackNoteId(w, t), title, message, ['Open coin', mute])
        .catch(() => undefined);
      sent += 1;
    }
  }
}
