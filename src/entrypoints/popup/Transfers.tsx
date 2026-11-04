import { useEffect, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import { formatCompact, parseDecimalInput } from '../../shared/format';
import type { PushEvent } from '../../shared/messages';
import { nativeSymbol, txUrl } from '../../shared/networks';
import type { TradeTicket } from '../../shared/panel';
import { SOLANA, SOLANA_CHAIN_ID, isSolana, nativeDecimals } from '../../shared/solana';
import { fallbackWallet, shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, SegTabs, TextField } from '../../ui/components';
import { ChainMark, Picker } from './Picker';

type Mode = 'distribute' | 'collect';

/**
 * Move native funds between your own wallets. Distribute: one wallet sends the same
 * amount to each selected wallet. Collect: the selected wallets send everything into one
 * wallet, minus a gas reserve on EVM chains (Solana wallets are left empty). The one
 * wallet starts as the default wallet. Each network lists the wallets with an address on it.
 */
export function Transfers({
  accounts,
  defaultChainId,
  initialMode = 'distribute',
}: {
  accounts: WalletAccount[];
  defaultChainId?: number;
  initialMode?: Mode;
}) {
  const chains = [...CHAINS.values()];
  const [mode, setMode] = useState<Mode>(initialMode);
  const [chainId, setChainId] = useState(defaultChainId ?? chains[0]?.id ?? 1);
  const sol = isSolana(chainId);
  const addressOf = (a: WalletAccount) => (sol ? a.solana : a.address) ?? '';
  const usable = accounts.filter((a) => addressOf(a) !== '');
  const visible = usable.filter((a) => !a.hidden);
  const [hubId, setHubId] = useState(fallbackWallet(usable)?.id ?? '');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [ticket, setTicket] = useState<TradeTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = visible.filter((a) => a.id !== hubId);

  useEffect(() => {
    setBalances({});
    void send({ type: 'wallets.balances', chainId }).then((r) => {
      if (r.ok) setBalances(Object.fromEntries(r.data.map((b) => [b.id, b.native])));
    });
  }, [chainId, ticket?.status]);

  // The hub can't also be one of the other wallets.
  useEffect(() => setSelected((s) => s.filter((id) => id !== hubId)), [hubId]);

  // Another network may not have the wallets picked: keep those that have an address on it.
  useEffect(() => {
    if (!usable.some((a) => a.id === hubId)) setHubId(fallbackWallet(usable)?.id ?? '');
    setSelected((s) => s.filter((id) => usable.some((a) => a.id === id)));
  }, [chainId]);

  // Live updates for the ticket started here.
  useEffect(() => {
    const onMsg = (msg: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = msg as PushEvent;
      if (ev?.kind === 'nesty.ticket')
        setTicket((t) => (t && t.id === ev.ticket.id ? ev.ticket : t));
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const sym = nativeSymbol(chainId);
  const bal = (id: string) =>
    formatCompact(Number(formatUnits(BigInt(balances[id] ?? '0'), nativeDecimals(chainId))));
  const each = parseDecimalInput(amount);
  const tooPrecise = each !== null && (each.split('.')[1]?.length ?? 0) > nativeDecimals(chainId);
  const n = selected.length;
  const plural = (k: number) => `${k} wallet${k === 1 ? '' : 's'}`;

  const run = async () => {
    setError(null);
    setBusy(true);
    const r =
      mode === 'distribute'
        ? await send({
            type: 'wallets.distribute',
            chainId,
            hubId,
            walletIds: selected,
            amountEach: each ?? '0',
          })
        : await send({ type: 'wallets.collect', chainId, hubId, walletIds: selected });
    setBusy(false);
    if (r.ok) setTicket(r.data);
    else setError(errorText(r));
  };

  const hubPicker = (
    <Picker
      title={mode === 'distribute' ? 'Send from' : 'Collect into'}
      value={hubId}
      onChange={setHubId}
      options={visible.map((a) => ({
        value: a.id,
        label: `${a.name}${a.primary ? ' ★' : ''}`,
        sub: `${shortAddress(addressOf(a))} · ${bal(a.id)} ${sym}`,
      }))}
    />
  );

  const list =
    others.length === 0 ? (
      <Notice>
        {visible.length < accounts.filter((a) => !a.hidden).length
          ? `Add another wallet first: keys imported from ${sol ? 'an EVM' : 'a Solana'} wallet have no ${sol ? 'Solana' : 'EVM'} address.`
          : 'Add another wallet first.'}
      </Notice>
    ) : (
      <div class="stack" style={{ gap: '6px' }}>
        {others.map((a) => (
          <label key={a.id} class="wallet" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span style={{ flex: 1 }}>{a.name}</span>
            <span class="muted mono">
              {bal(a.id)} {sym}
            </span>
          </label>
        ))}
      </div>
    );

  return (
    <div class="stack">
      <h2>Move funds</h2>
      <SegTabs
        label="Transfer type"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setTicket(null);
          setError(null);
        }}
        options={[
          { value: 'distribute', label: 'Distribute' },
          { value: 'collect', label: 'Collect' },
        ]}
      />
      <p class="muted">
        {mode === 'distribute'
          ? 'Send the same amount from one wallet to several others.'
          : sol
            ? 'Move all the SOL of several wallets into one, leaving them empty.'
            : 'Move everything from several wallets into one, keeping a little for gas.'}
      </p>

      <div class="field">
        <span class="label">Network</span>
        <Picker
          title="Move funds on"
          value={chainId}
          onChange={setChainId}
          options={[
            ...chains.map((c) => ({
              value: c.id,
              label: c.name,
              sub: c.nativeCurrency.symbol,
              mark: <ChainMark chainId={c.id} />,
            })),
            {
              value: SOLANA_CHAIN_ID,
              label: SOLANA.name,
              sub: SOLANA.nativeCurrency.symbol,
              mark: <ChainMark chainId={SOLANA_CHAIN_ID} />,
            },
          ]}
        />
      </div>

      {mode === 'distribute' ? (
        <>
          <div class="field">
            <span class="label">From</span>
            {hubPicker}
          </div>
          <div class="field">
            <span class="label">To</span>
            {list}
          </div>
          <TextField
            label={`Amount each wallet receives (${sym})`}
            value={amount}
            onInput={setAmount}
            placeholder="0.01"
          />
          {tooPrecise && (
            <p class="error">
              {sym} has {nativeDecimals(chainId)} decimals at most.
            </p>
          )}
        </>
      ) : (
        <>
          <div class="field">
            <span class="label">From</span>
            {list}
          </div>
          <div class="field">
            <span class="label">Into</span>
            {hubPicker}
          </div>
        </>
      )}

      <Button
        variant="primary"
        disabled={busy || n === 0 || !hubId || (mode === 'distribute' && (!each || tooPrecise))}
        onClick={() => void run()}
      >
        {busy
          ? 'Sending…'
          : n === 0
            ? 'Select wallets'
            : mode === 'distribute'
              ? `Send ${each ?? '…'} ${sym} to ${plural(n)}`
              : `Collect from ${plural(n)}`}
      </Button>
      <p class="hint">
        Transfers only go between your own wallets.
        {mode === 'distribute' ? ' Your USD limits apply.' : ''}
      </p>
      {error && <p class="error">{error}</p>}
      {ticket && (
        <div class="card" style={{ padding: '10px', display: 'grid', gap: '4px' }}>
          <strong>
            {ticket.kind === 'distribute' ? 'Distribute' : 'Collect'}: {ticket.status}
          </strong>
          {ticket.legs.map((l, i) => {
            const tx = l.hash ?? l.sig;
            return (
              <span key={i} class="muted">
                {l.walletName} · {l.status}
                {tx && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={txUrl(ticket.chainId, tx)} target="_blank" rel="noopener noreferrer">
                      view
                    </a>
                  </>
                )}
                {l.error && ` · ${l.error}`}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
