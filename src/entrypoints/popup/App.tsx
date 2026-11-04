import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import type { PushEvent } from '../../shared/messages';
import { SOLANA, isSolana } from '../../shared/solana';
import type { WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField } from '../../ui/components';
import { Activity } from './Activity';
import { ActivityDetail } from './ActivityDetail';
import { Receive } from './Receive';
import { Send } from './Send';
import { TokenDetail } from './TokenDetail';
import { Groups } from './Groups';
import { Bridge } from './Bridge';
import { Home } from './Home';
import { IconActivity, IconBack, IconBridge, IconLock, IconSettings, IconWallet } from './icons';
import { ChainMark, Picker } from './Picker';
import { ResetVault } from './ResetVault';
import { Settings } from './Settings';
import { Transfers } from './Transfers';
import { NestMark } from '../../ui/NestMark';
import { ImportKey } from './ImportKey';
import { useScreenMotion } from './motion';
import { WalletDetail } from './WalletDetail';

type Tab = 'wallets' | 'activity' | 'bridge' | 'settings';
type Sub =
  | { name: 'detail'; id: string }
  | { name: 'import' }
  | { name: 'ticket'; id: string }
  | { name: 'send'; walletId: string | null; token?: string }
  | { name: 'token'; token: string; walletIds: string[] }
  | { name: 'groups' }
  | { name: 'receive'; walletId: string | null }
  | { name: 'transfers'; mode: 'distribute' | 'collect' }
  | null;
type Gate = 'loading' | 'no-vault' | 'locked' | 'ready';

const CHAIN_KEY = 'nesty.popup.chain';
const TAB_KEY = 'nesty.popup.tab';

function remembered<T extends string | number>(
  key: string,
  fallback: T,
  valid: (v: string) => boolean,
): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && valid(v)) return (typeof fallback === 'number' ? Number(v) : v) as T;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function remember(key: string, v: string | number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable */
  }
}

const TABS: { id: Tab; label: string; Icon: typeof IconWallet }[] = [
  { id: 'wallets', label: 'Wallets', Icon: IconWallet },
  { id: 'activity', label: 'Activity', Icon: IconActivity },
  { id: 'bridge', label: 'Bridge', Icon: IconBridge },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
];

export function App() {
  const chains = [...CHAINS.values()];
  const [gate, setGate] = useState<Gate>('loading');
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [tab, setTab] = useState<Tab>(() =>
    remembered<Tab>(TAB_KEY, 'wallets', (v) => TABS.some((t) => t.id === v)),
  );
  const [sub, setSub] = useState<Sub>(null);
  const [chainId, setChainId] = useState<number>(() =>
    remembered(CHAIN_KEY, chains[0]?.id ?? 1, (v) => CHAINS.has(Number(v)) || isSolana(Number(v))),
  );
  const [pending, setPending] = useState(0);

  const refresh = useCallback(async () => {
    const status = await send({ type: 'vault.status' });
    if (!status.ok || !status.data.exists) return setGate('no-vault');
    if (!status.data.unlocked) return setGate('locked');
    const list = await send({ type: 'wallets.list' });
    if (!list.ok) return setGate('locked');
    setAccounts(list.data);
    setGate('ready');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pending badge on the Activity tab.
  useEffect(() => {
    if (gate !== 'ready') return;
    const count = () =>
      void send({ type: 'history.list' }).then(
        (r) => r.ok && setPending(r.data.filter((t) => t.status === 'working').length),
      );
    count();
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id === browser.runtime.id && (m as PushEvent)?.kind === 'nesty.ticket') count();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [gate]);

  const lock = async () => {
    await send({ type: 'vault.lock' });
    setAccounts([]);
    setSub(null);
    setGate('locked');
  };

  const go = (t: Tab) => {
    setTab(t);
    setSub(null);
    remember(TAB_KEY, t);
  };

  const pickChain = (id: number) => {
    setChainId(id);
    remember(CHAIN_KEY, id);
  };

  const showChainPicker = gate === 'ready' && !sub && (tab === 'wallets' || tab === 'activity');

  // Each screen is keyed so it remounts and plays its entrance; the scroll starts at the top.
  const screenKey =
    gate !== 'ready' ? gate : sub ? `${sub.name}:${'id' in sub ? sub.id : ''}` : tab;
  const tabIndex = TABS.findIndex((x) => x.id === tab);
  const motion = useScreenMotion({ key: screenKey, depth: sub ? 1 : 0, index: tabIndex });
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [screenKey]);
  const navOn = (id: Tab) =>
    tab === id &&
    (!sub ||
      (sub.name === 'ticket' && id === 'activity') ||
      (sub.name === 'token' && id === 'wallets'));
  const navIndex = TABS.findIndex((x) => navOn(x.id));

  return (
    <div class="popup">
      {/* The trade detail brings its own header, with the back button beside the title. */}
      {sub?.name !== 'ticket' &&
        sub?.name !== 'token' &&
        !(gate === 'ready' && !sub && tab === 'settings') && (
          <header class="topbar">
            {sub && (
              <button type="button" class="icon-btn" aria-label="Back" onClick={() => setSub(null)}>
                <IconBack size={18} />
              </button>
            )}
            <h1 class="brand">
              <NestMark size={20} />
              Nesty
            </h1>
            <span class="spacer" />
            {/* One chain for Wallets and Activity: switching on either changes both. */}
            {showChainPicker && (
              <Picker
                title="Select chain"
                variant="pill"
                value={chainId}
                onChange={pickChain}
                options={[
                  ...chains.map((c) => ({
                    value: c.id,
                    label: c.name,
                    sub: c.nativeCurrency.symbol,
                    mark: <ChainMark chainId={c.id} />,
                  })),
                  {
                    value: SOLANA.id,
                    label: SOLANA.name,
                    sub: SOLANA.nativeCurrency.symbol,
                    mark: <ChainMark chainId={SOLANA.id} />,
                  },
                ]}
              />
            )}
            {gate === 'ready' && (
              <button
                type="button"
                class="icon-btn"
                aria-label="Lock"
                title="Lock"
                onClick={() => void lock()}
              >
                <IconLock size={16} />
              </button>
            )}
          </header>
        )}

      <main class="content" ref={contentRef}>
        <div class="screen" key={screenKey} data-motion={motion}>
          {gate === 'loading' && <p class="muted">Loading…</p>}
          {gate === 'no-vault' && <NoVault />}
          {gate === 'locked' && (
            <Unlock
              onUnlocked={() => {
                // Opened by a website to unlock in: that done, the window goes away. The
                // site hears the unlock from the vault event and carries on by itself.
                if (forSite) window.close();
                void refresh();
              }}
              onReset={() => void refresh()}
            />
          )}
          {gate === 'ready' && sub?.name === 'detail' && (
            <WalletDetail
              account={accounts.find((a) => a.id === sub.id)}
              onChanged={refresh}
              onRemoved={() => void refresh().then(() => setSub(null))}
            />
          )}
          {gate === 'ready' && sub?.name === 'import' && (
            <ImportKey onDone={() => void refresh().then(() => setSub(null))} />
          )}
          {gate === 'ready' && sub?.name === 'transfers' && (
            <Transfers accounts={accounts} defaultChainId={chainId} initialMode={sub.mode} />
          )}
          {gate === 'ready' && !sub && tab === 'wallets' && (
            <Home
              chainId={chainId}
              accounts={accounts}
              onManage={(id) => setSub({ name: 'detail', id })}
              onImport={() => setSub({ name: 'import' })}
              onTransfers={(mode) => setSub({ name: 'transfers', mode })}
              onSend={(walletId) => setSub({ name: 'send', walletId })}
              onReceive={(walletId) => setSub({ name: 'receive', walletId })}
              onToken={(token, walletIds) => setSub({ name: 'token', token, walletIds })}
              onGroups={() => setSub({ name: 'groups' })}
              onChanged={refresh}
            />
          )}
          {gate === 'ready' && sub?.name === 'groups' && <Groups accounts={accounts} />}
          {gate === 'ready' && sub?.name === 'token' && (
            <TokenDetail
              chainId={chainId}
              token={sub.token}
              accounts={accounts}
              walletIds={sub.walletIds}
              onBack={() => setSub(null)}
              onSend={(walletId, token) => setSub({ name: 'send', walletId, token })}
              onAllTrades={() => go('activity')}
              onOpenTicket={(id) => {
                go('activity');
                setSub({ name: 'ticket', id });
              }}
            />
          )}
          {gate === 'ready' && sub?.name === 'ticket' && (
            <ActivityDetail id={sub.id} onBack={() => setSub(null)} />
          )}
          {gate === 'ready' && sub?.name === 'send' && (
            <Send
              accounts={accounts}
              defaultChainId={chainId}
              initialWalletId={sub.walletId}
              initialToken={sub.token}
              onSent={(id) => {
                go('activity');
                setSub({ name: 'ticket', id });
              }}
            />
          )}
          {gate === 'ready' && sub?.name === 'receive' && (
            <Receive accounts={accounts} chainId={chainId} initialWalletId={sub.walletId} />
          )}
          {gate === 'ready' && !sub && tab === 'activity' && (
            <Activity chainFilter={chainId} onOpen={(id) => setSub({ name: 'ticket', id })} />
          )}
          {gate === 'ready' && !sub && tab === 'bridge' && (
            <Bridge accounts={accounts} defaultChainId={chainId} />
          )}
          {gate === 'ready' && !sub && tab === 'settings' && (
            <Settings onReset={() => setGate('no-vault')} />
          )}
        </div>
      </main>

      {gate === 'ready' && (
        <nav class="nav" aria-label="Sections">
          <span
            class="nav-ind"
            aria-hidden="true"
            style={{
              transform: `translateX(${Math.max(navIndex, 0) * 100}%)`,
              opacity: navIndex < 0 ? 0 : 1,
            }}
          />
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              class="nav-item"
              aria-current={navOn(id) ? 'page' : undefined}
              onClick={() => go(id)}
            >
              <Icon size={20} />
              {label}
              {id === 'activity' && pending > 0 && <span class="badge-dot">{pending}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function openOnboarding() {
  void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
  window.close();
}

function NoVault() {
  return (
    <div class="center">
      <h2>Welcome to Nesty</h2>
      <p class="muted">One-click trading from your own wallet, right on the chart.</p>
      <Button variant="primary" block onClick={openOnboarding}>
        Set up wallet
      </Button>
    </div>
  );
}

/** Opened by a website to unlock in (see openUnlock in the background): no popup to keep. */
const forSite = new URLSearchParams(location.search).get('for') === 'site';

function Unlock({ onUnlocked, onReset }: { onUnlocked: () => void; onReset: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  if (forgot) {
    return (
      <div class="stack" style={{ paddingTop: '24px' }}>
        <ResetVault onReset={onReset} />
        <Button size="sm" variant="ghost" onClick={() => setForgot(false)}>
          Back to unlock
        </Button>
      </div>
    );
  }

  return (
    <form
      class="stack"
      style={{ paddingTop: '24px' }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await send({ type: 'vault.unlock', password });
        setBusy(false);
        setPassword('');
        if (res.ok) onUnlocked();
        else setError(errorText(res));
      }}
    >
      <h2>Unlock</h2>
      <PasswordField
        label="Password"
        value={password}
        onInput={(v) => (setPassword(v), setError(undefined))}
        autoFocus
        error={error}
      />
      <Button variant="primary" type="submit" block disabled={busy || !password}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
      <button type="button" class="link" onClick={() => setForgot(true)}>
        Forgot password?
      </button>
    </form>
  );
}
