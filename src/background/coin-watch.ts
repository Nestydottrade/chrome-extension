import { CoinSocket, type OpenSocket, type SocketKind } from './coin-socket';

// Which coin each panel watches, and one socket per chain to hear those coins trade. A panel
// renews its watch every few seconds while shown; a watch not renewed lapses (a closed or
// navigated tab sends nothing more), and a chain's socket closes a while after its last watch.

/** A watch lapses this long after its last renewal. */
export const LEASE_MS = 15_000;
/** A chain's socket outlives its last watch this long: a panel moving to another coin keeps it. */
export const IDLE_CLOSE_MS = 60_000;
/** At most one "it traded" per tab in this window; a trade inside it is told when it ends. */
export const NOTIFY_GAP_MS = 1_000;
const SWEEP_MS = 5_000;

export interface CoinWatchDeps {
  now: () => number;
  open: OpenSocket;
  /** The socket a chain's coins are heard on; '' for none. */
  socketUrl: (chainId: number) => Promise<string>;
  kindOf: (chainId: number) => SocketKind;
  /**
   * What the socket watches for a coin: the token on an EVM chain, the account its trades
   * change on Solana (its curve or pool, which moves when it graduates); null when nothing
   * trades it. Asked again at each renewal.
   */
  targetOf: (chainId: number, token: string) => Promise<string | null>;
  /** Tells a tab its coin traded. */
  notify: (tabId: number, chainId: number, token: string) => void;
}

interface Lease {
  chainId: number;
  token: string;
  /** What the socket watches for it (see `targetOf`). */
  key: string;
  until: number;
  stop: () => void;
  toldAt: number;
  later: ReturnType<typeof setTimeout> | null;
}

interface ChainSocket {
  url: string;
  socket: CoinSocket;
  idle: ReturnType<typeof setTimeout> | null;
}

export class CoinWatch {
  private readonly leases = new Map<number, Lease>();
  private readonly sockets = new Map<number, ChainSocket>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: CoinWatchDeps) {}

  /** Starts or renews a tab's watch; tells whether the coin's trades are heard right now. */
  async watch(tabId: number, chainId: number, token: string): Promise<{ live: boolean }> {
    const url = await this.d.socketUrl(chainId);
    const key = url ? await this.d.targetOf(chainId, token).catch(() => null) : null;
    this.dropLapsed();
    if (!url || !key) {
      this.drop(tabId);
      return { live: false };
    }
    const cs = this.socketFor(chainId, url);
    const cur = this.leases.get(tabId);
    if (cur && cur.chainId === chainId && cur.key === key) {
      cur.until = this.d.now() + LEASE_MS;
      return { live: cs.socket.coinLive(key) };
    }
    const lease: Lease = {
      chainId,
      token,
      key,
      until: this.d.now() + LEASE_MS,
      stop: () => undefined,
      toldAt: Number.NEGATIVE_INFINITY,
      later: null,
    };
    lease.stop = cs.socket.watch(key, () => this.heard(tabId, lease));
    this.leases.set(tabId, lease);
    // Ended after the new one started, so a socket both use never counts as idle between.
    if (cur) this.end(cur);
    this.sweep ??= setInterval(() => this.dropLapsed(), SWEEP_MS);
    return { live: cs.socket.coinLive(key) };
  }

  /** Ends a tab's watch (its panel closed, or the tab did). */
  drop(tabId: number): void {
    const lease = this.leases.get(tabId);
    if (!lease) return;
    this.leases.delete(tabId);
    this.end(lease);
    if (this.leases.size === 0 && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  /** Ends every watch (the wallet locked: no coin is heard until it unlocks). */
  clear(): void {
    for (const tabId of [...this.leases.keys()]) this.drop(tabId);
  }

  private dropLapsed(): void {
    const now = this.d.now();
    for (const [tabId, lease] of [...this.leases]) if (lease.until < now) this.drop(tabId);
  }

  /** The chain's socket on `url`, opened (or moved there, with its watches) as needed. */
  private socketFor(chainId: number, url: string): ChainSocket {
    const cur = this.sockets.get(chainId);
    if (cur?.url === url) {
      if (cur.idle) clearTimeout(cur.idle);
      cur.idle = null;
      return cur;
    }
    if (cur) {
      if (cur.idle) clearTimeout(cur.idle);
      cur.socket.close();
    }
    const socket = new CoinSocket(url, this.d.kindOf(chainId), {
      now: this.d.now,
      open: this.d.open,
    });
    const cs: ChainSocket = { url, socket, idle: null };
    this.sockets.set(chainId, cs);
    for (const [tabId, lease] of this.leases)
      if (lease.chainId === chainId)
        lease.stop = socket.watch(lease.key, () => this.heard(tabId, lease));
    return cs;
  }

  private end(lease: Lease): void {
    lease.stop();
    if (lease.later) clearTimeout(lease.later);
    lease.later = null;
    const cs = this.sockets.get(lease.chainId);
    if (!cs || cs.socket.size() > 0 || cs.idle) return;
    cs.idle = setTimeout(() => {
      cs.idle = null;
      if (cs.socket.size() > 0 || this.sockets.get(lease.chainId) !== cs) return;
      cs.socket.close();
      this.sockets.delete(lease.chainId);
    }, IDLE_CLOSE_MS);
  }

  private heard(tabId: number, lease: Lease): void {
    if (this.leases.get(tabId) !== lease || lease.later) return;
    const wait = lease.toldAt + NOTIFY_GAP_MS - this.d.now();
    if (wait <= 0) {
      this.tell(tabId, lease);
      return;
    }
    lease.later = setTimeout(() => {
      lease.later = null;
      if (this.leases.get(tabId) === lease) this.tell(tabId, lease);
    }, wait);
  }

  private tell(tabId: number, lease: Lease): void {
    lease.toldAt = this.d.now();
    this.d.notify(tabId, lease.chainId, lease.token);
  }
}
