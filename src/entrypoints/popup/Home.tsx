import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatUnits, type Address } from 'viem';
import { browser } from 'wxt/browser';
import { formatCompact, formatToken, formatUsd } from '../../shared/format';
import type { Portfolio, PortfolioTokenView, PushEvent } from '../../shared/messages';
import { nativeSymbol, networkName } from '../../shared/networks';
import { isSolAddress, isSolana, nativeDecimals } from '../../shared/solana';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { useCopy } from '../../ui/components';
import { heldBy, pnlOf, signedUsd, valueOf } from './holdings';
import {
  IconChevronDown,
  IconCopy,
  IconDistribute,
  IconKey,
  IconReceive,
  IconSend,
  IconSpark,
} from './icons';
import { Sheet } from './Picker';
import { TokenAvatar } from './TokenAvatar';

const SEL_KEY = 'nesty.popup.wallet';

function loadSel(): string {
  try {
    return localStorage.getItem(SEL_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

function saveSel(v: string) {
  try {
    localStorage.setItem(SEL_KEY, v);
  } catch {
    /* storage unavailable: selection just isn't remembered */
  }
}

/** What the wallet's tile shows: its number for "Wallet 3", else its first letter. */
function initial(a: WalletAccount): string {
  const m = a.name.match(/^Wallet (\d+)$/);
  if (m) return m[1] ?? '?';
  return ([...a.name][0] ?? '?').toUpperCase();
}

// Wallet tiles cycle through these so neighbours never look alike.
const TINTS = ['#2ee6a8', '#8fb4ff', '#ff9f6e', '#7fe3ff', '#c9a7ff', '#ff7d94'];

export function Home({
  chainId,
  accounts,
  onManage,
  onImport,
  onTransfers,
  onSend,
  onReceive,
  onToken,
  onGroups,
  onChanged,
}: {
  chainId: number;
  accounts: WalletAccount[];
  onManage: (id: string) => void;
  onImport: () => void;
  onTransfers: (mode: 'distribute' | 'collect') => void;
  /** The selected wallet, or null when "All" is selected. */
  onSend: (walletId: string | null) => void;
  onReceive: (walletId: string | null) => void;
  /** Open a token's page, for the wallets the page is showing. */
  onToken: (token: string, walletIds: string[]) => void;
  /** Saved wallet groups for the trading panel. */
  onGroups: () => void;
  onChanged: () => Promise<void>;
}) {
  const native = nativeSymbol(chainId);
  const nd = nativeDecimals(chainId);
  // Each network lists the wallets with an address on it: a key imported for one chain
  // family has none on the other.
  const sol = isSolana(chainId);
  const addressOf = (a: WalletAccount) => (sol ? a.solana : a.address) ?? '';
  const usable = accounts.filter((a) => addressOf(a) !== '');
  const [showHidden, setShowHidden] = useState(false);
  const pills = usable.filter((a) => showHidden || !a.hidden);
  const [sel, setSel] = useState(loadSel);
  const selected = sel === 'all' ? null : (usable.find((a) => a.id === sel) ?? null);
  // Every listed wallet is loaded so each row shows its value; the selection only filters.
  const fetchIds = [
    ...pills.map((a) => a.id),
    ...(selected && !pills.includes(selected) ? [selected.id] : []),
  ];
  const walletIds = selected ? [selected.id] : pills.map((a) => a.id);

  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDust, setShowDust] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [walletsOpen, setWalletsOpen] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [copied, copy] = useCopy();

  const load = useCallback(async () => {
    // Nothing to read (every wallet hidden, or none on this network): no endless skeleton.
    if (fetchIds.length === 0) return setLoading(false);
    setLoading(true);
    const r = await send({ type: 'portfolio.get', chainId, walletIds: fetchIds });
    setLoading(false);
    if (r.ok) setData(r.data);
    else setMsg(errorText(r));
  }, [chainId, fetchIds.join()]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  // Refresh after a trade from this popup (or the panel) confirms.
  useEffect(() => {
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = m as PushEvent;
      if (
        ev?.kind === 'nesty.ticket' &&
        ev.ticket.chainId === chainId &&
        ev.ticket.status !== 'working'
      )
        void load();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [load, chainId]);

  const pick = (v: string) => {
    setSel(v);
    saveSel(v);
    setWalletsOpen(false);
  };
  /** A wallet keeps its tint wherever it shows, hidden or not. */
  const tint = (a: WalletAccount) => TINTS[accounts.indexOf(a) % TINTS.length];

  /** First read of this chain's balances: show placeholders, not zeros. */
  const waiting = data === null && loading;

  const nativeOf = (ids: string[]) =>
    ids.reduce((s, id) => s + BigInt(data?.native[id] ?? '0'), 0n);
  const usdOfNative = (wei: bigint) =>
    data?.nativeUsd ? Number(formatUnits(wei, nd)) * data.nativeUsd : null;
  const nativeTotal = nativeOf(walletIds);
  const nativeUsd = usdOfNative(nativeTotal);
  const tokens = (data?.tokens ?? [])
    .filter((t) => heldBy(t, walletIds) > 0n)
    .sort(
      (a, b) => (valueOf(b, heldBy(b, walletIds)) ?? -1) - (valueOf(a, heldBy(a, walletIds)) ?? -1),
    );
  const visible = tokens.filter((t) => !t.dust && !t.unsolicited);
  const dust = tokens.filter((t) => t.dust && !t.unsolicited);
  // Airdrops the user never bought: often scams with a faked price, never in totals.
  const spam = tokens.filter((t) => t.unsolicited);
  const totalUsd =
    nativeUsd === null
      ? null
      : nativeUsd + visible.reduce((s, t) => s + (valueOf(t, heldBy(t, walletIds)) ?? 0), 0);
  /** One wallet's value: native plus its share of the tokens counted in totals. */
  const walletUsd = (id: string) => {
    const n = usdOfNative(nativeOf([id]));
    if (n === null) return null;
    return (data?.tokens ?? [])
      .filter((t) => !t.dust && !t.unsolicited)
      .reduce((s, t) => s + (valueOf(t, heldBy(t, [id])) ?? 0), n);
  };

  /** Open PnL over the tokens counted in totals, and on how many of them. */
  const openPnl = (ids: string[]) => {
    let usd = 0;
    let count = 0;
    for (const t of data?.tokens ?? []) {
      if (t.dust || t.unsolicited) continue;
      const p = pnlOf(t, ids, data?.nativeUsd ?? null, nd);
      if (!p) continue;
      usd += p.usd;
      count += 1;
    }
    return count > 0 ? { usd, count } : null;
  };
  const cardPnl = openPnl(walletIds);

  // Distribute moves money between your own wallets (collecting is a tab there): it needs
  // two with an address on this network.
  const distribute = () => {
    if (usable.length >= 2) onTransfers('distribute');
    else if (accounts.length < 2)
      setMsg('Distribute needs a second wallet. Add one with + Add wallet.');
    else
      setMsg(
        `Distribute needs a second wallet with ${sol ? 'a Solana' : 'an EVM'} address. Add one with + Add wallet.`,
      );
  };

  const addWallet = async () => {
    const r = await send({ type: 'wallets.add' });
    if (r.ok) {
      await onChanged();
      pick(r.data.id);
    } else setMsg(errorText(r));
  };

  const addToken = async () => {
    const addr = newToken.trim();
    if (sol ? !isSolAddress(addr) : !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setMsg(sol ? 'Enter a token mint address.' : 'Enter a token contract address (0x…).');
      return;
    }
    // On Solana, adding marks the mint as the user's own: it is then read and shown.
    const r = sol
      ? await send({ type: 'sol.portfolio.setTrusted', mint: addr, trusted: true })
      : await send({ type: 'portfolio.addToken', chainId, token: addr as Address });
    if (r.ok) {
      setAdding(false);
      setNewToken('');
      await load();
    } else setMsg(errorText(r));
  };

  const tokenRow = (t: PortfolioTokenView) => {
    const holders = walletIds.filter((id) => BigInt(t.perWallet[id] ?? '0') > 0n).length;
    const amount = heldBy(t, walletIds);
    const value = valueOf(t, amount);
    return (
      <li key={t.address} class={`tok${t.dust || t.unsolicited ? ' is-dust' : ''}`}>
        <button
          type="button"
          class="tok-main"
          title={t.unsolicited ? 'Sent to you, never bought: often a scam' : `Open ${t.symbol}`}
          onClick={() => onToken(t.address, walletIds)}
        >
          <TokenAvatar chainId={chainId} token={t.address} symbol={t.symbol} />
          <span class="tname">
            {t.symbol}
            <small>{selected ? t.name : `in ${holders} wallet${holders === 1 ? '' : 's'}`}</small>
          </span>
          <span class="tval">
            {value !== null ? formatUsd(value) : 'Unpriced'}
            <small>{formatToken(amount, t.decimals)}</small>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div class="stack" style={{ gap: '10px' }}>
      <section class="card port" aria-label="Portfolio">
        <div class="row">
          <button
            type="button"
            class="wsw"
            aria-haspopup="dialog"
            title="Switch wallet"
            onClick={() => setWalletsOpen(true)}
          >
            {selected ? (
              <span class="wl-tile wl-tile--sm" style={{ background: tint(selected) }}>
                {initial(selected)}
              </span>
            ) : (
              <span class="wl-tile wl-tile--sm wl-tile--all">{pills.length}</span>
            )}
            <span class="wname">{selected ? selected.name : 'All wallets'}</span>
            <IconChevronDown size={14} />
          </button>
          {selected && (
            <button
              type="button"
              class="addr-btn mono"
              onClick={() => void copy(addressOf(selected))}
              title="Copy address"
            >
              {copied ? 'Copied' : shortAddress(addressOf(selected))} <IconCopy size={11} />
            </button>
          )}
          <span class="spacer" />
          {selected && (
            <button type="button" class="link" onClick={() => onManage(selected.id)}>
              Manage
            </button>
          )}
        </div>
        {waiting ? (
          <span class="big">
            <span class="skel skel--big" />
          </span>
        ) : (
          <span class="big">{totalUsd !== null ? formatUsd(totalUsd) : '–'}</span>
        )}
        {waiting ? (
          <span class="skel skel--line" />
        ) : cardPnl ? (
          <span class={`pnl-line ${cardPnl.usd >= 0 ? 'up' : 'down'}`}>
            {signedUsd(cardPnl.usd)} open PnL on {cardPnl.count} token
            {cardPnl.count === 1 ? '' : 's'}
          </span>
        ) : (
          <span class="muted small">
            {formatCompact(Number(formatUnits(nativeTotal, nd)))} {native}
            {visible.length > 0 &&
              ` + ${visible.length} token${visible.length === 1 ? '' : 's'}`}{' '}
            on {networkName(chainId)}
          </span>
        )}
        <div class="wallet-acts">
          <button type="button" class="wact" onClick={() => onSend(selected?.id ?? null)}>
            <IconSend size={17} />
            Send
          </button>
          <button type="button" class="wact" onClick={() => onReceive(selected?.id ?? null)}>
            <IconReceive size={17} />
            Receive
          </button>
          <button
            type="button"
            class="wact"
            title="Spread funds from one wallet to the others, or collect them back into one"
            onClick={distribute}
          >
            <IconDistribute size={17} />
            Distribute
          </button>
        </div>
      </section>

      <Sheet title="Wallets" open={walletsOpen} onClose={() => setWalletsOpen(false)}>
        <ul class="wl-list wl-sheet">
          <li>
            <button
              type="button"
              class="wl-row"
              aria-pressed={!selected}
              onClick={() => pick('all')}
            >
              <span class="wl-tile wl-tile--all">{pills.length}</span>
              <span class="wl-main">
                <span class="wl-name">All wallets</span>
                <span class="wl-addr">Totals across every listed wallet</span>
              </span>
              <span class="wl-val">
                {waiting ? (
                  <span class="skel skel--val" />
                ) : totalUsd !== null ? (
                  formatUsd(totalUsd)
                ) : (
                  '–'
                )}
              </span>
            </button>
          </li>
          {pills.map((a) => {
            const usd = walletUsd(a.id);
            const pnl = openPnl([a.id]);
            const on = selected?.id === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  class={`wl-row${a.hidden ? ' is-hidden' : ''}`}
                  aria-pressed={on}
                  title={`Show only ${a.name}`}
                  onClick={() => pick(a.id)}
                >
                  <span class="wl-tile" style={{ background: tint(a) }}>
                    {initial(a)}
                  </span>
                  <span class="wl-main">
                    <span class="wl-name">
                      {a.name}
                      {a.primary && <span class="tag tag--primary">Primary</span>}
                      {a.hidden && <span class="tag">Hidden</span>}
                    </span>
                    <span class="wl-addr">
                      {shortAddress(addressOf(a))}
                      {!waiting &&
                        ` · ${formatCompact(Number(formatUnits(nativeOf([a.id]), nd)))} ${native}`}
                    </span>
                  </span>
                  <span class="wl-val">
                    {waiting ? (
                      <span class="skel skel--val" />
                    ) : usd !== null ? (
                      formatUsd(usd)
                    ) : (
                      '–'
                    )}
                    {pnl && (
                      <small class={pnl.usd >= 0 ? 'up' : 'down'}>{signedUsd(pnl.usd)}</small>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {usable.length < accounts.length && (
          <p class="hint wl-sheet-note">
            {sol
              ? 'Wallets imported from an EVM key have no Solana address, so they are not listed here.'
              : 'Wallets imported from a Solana key have no EVM address, so they are not listed here.'}
          </p>
        )}
        <div class="wl-sheet-foot">
          {usable.some((a) => a.hidden) && (
            <button type="button" class="link" onClick={() => setShowHidden(!showHidden)}>
              {showHidden
                ? 'Hide hidden'
                : `Show hidden (${usable.filter((a) => a.hidden).length})`}
            </button>
          )}
          <span class="spacer" />
          <button
            type="button"
            class="link"
            onClick={() => {
              setWalletsOpen(false);
              onGroups();
            }}
          >
            Groups
          </button>
          <button
            type="button"
            class="link"
            onClick={() => {
              setWalletsOpen(false);
              setAddOpen(true);
            }}
          >
            + Add wallet
          </button>
        </div>
      </Sheet>

      <div class="row">
        <span class="section-title">Tokens</span>
        <span class="spacer" />
        <span class="hint">{loading ? 'Updating…' : 'Sorted by value'}</span>
      </div>
      {waiting ? (
        <ul class="toks" aria-busy="true" aria-label="Loading balances">
          {[0, 1, 2].map((i) => (
            <li key={i} class="tok">
              <div class="tok-main static">
                <span class="skel skel--avatar" />
                <span class="tname">
                  <span class="skel skel--name" />
                  <span class="skel skel--sub" />
                </span>
                <span class="tval">
                  <span class="skel skel--val" />
                  <span class="skel skel--sub" />
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul class="toks">
          <li class="tok">
            <div class="tok-main static">
              <TokenAvatar chainId={chainId} token="native" symbol={native} />
              <span class="tname">
                {native}
                <small>Native</small>
              </span>
              <span class="tval">
                {nativeUsd !== null ? formatUsd(nativeUsd) : '–'}
                <small>{formatCompact(Number(formatUnits(nativeTotal, nd)))}</small>
              </span>
            </div>
          </li>
          {visible.map(tokenRow)}
          {showDust && dust.map(tokenRow)}
          {showSpam && spam.map(tokenRow)}
        </ul>
      )}
      {spam.length > 0 && (
        <button
          type="button"
          class="dust"
          onClick={() => setShowSpam(!showSpam)}
          aria-expanded={showSpam}
          title="Tokens sent to your wallets that you never bought or added. Often scams."
        >
          <span>
            {spam.length} token{spam.length === 1 ? '' : 's'} you didn't buy{' '}
            {showSpam ? 'shown' : 'hidden'}
          </span>
          <span class="spacer" />
          <span class="showlink">{showSpam ? 'Hide' : 'Show'}</span>
        </button>
      )}
      {dust.length > 0 && (
        <button
          type="button"
          class="dust"
          onClick={() => setShowDust(!showDust)}
          aria-expanded={showDust}
        >
          <span>
            {dust.length} small or unpriced token{dust.length === 1 ? '' : 's'}{' '}
            {showDust ? 'shown' : 'hidden'}
          </span>
          <span class="spacer" />
          <span class="showlink">{showDust ? 'Hide' : 'Show'}</span>
        </button>
      )}

      {adding ? (
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void addToken();
          }}
        >
          <input
            class="input mono"
            aria-label={sol ? 'Token mint address' : 'Token contract address'}
            placeholder={sol ? 'Token mint address' : '0x… token address'}
            value={newToken}
            onInput={(e) => setNewToken(e.currentTarget.value)}
          />
          <button type="submit" class="btn btn--sm btn--primary">
            Add
          </button>
        </form>
      ) : (
        <button
          type="button"
          class="link"
          style={{ justifySelf: 'start' }}
          onClick={() => setAdding(true)}
        >
          + Add token
        </button>
      )}

      {msg && (
        <p class="hint" role="status">
          {msg}
        </p>
      )}

      <Sheet title="Add a wallet" open={addOpen} onClose={() => setAddOpen(false)}>
        <div class="sheet-list">
          <button
            type="button"
            class="sheet-row"
            onClick={() => {
              setAddOpen(false);
              void addWallet();
            }}
          >
            <span class="add-ico accent">
              <IconSpark size={18} />
            </span>
            <span class="sheet-text">
              <span>Create new wallet</span>
              <small>Next address from your recovery phrase. Restorable.</small>
            </span>
          </button>
          <button
            type="button"
            class="sheet-row"
            onClick={() => {
              setAddOpen(false);
              onImport();
            }}
          >
            <span class="add-ico">
              <IconKey size={18} />
            </span>
            <span class="sheet-text">
              <span>Import private key</span>
              <small>From MetaMask or another app. Back up the key yourself.</small>
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
