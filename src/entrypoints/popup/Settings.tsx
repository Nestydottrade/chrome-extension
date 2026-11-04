import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { isNestySite } from '../../shared/nesty-site';
import { CHAINS, chainLabel } from '../../shared/chains';
import { formatPercent, formatToken, parseDecimalInput } from '../../shared/format';
import type { ApprovalView, SiteStatus, WsStatusView } from '../../shared/messages';
import type { Address } from 'viem';
import type { ChainSettings, GlobalSettings, SolanaSettings } from '../../shared/settings/defaults';
import { SOLANA, SOLANA_CHAIN_ID, isSolana } from '../../shared/solana';
import { errorText, send } from '../../ui/api';
import { NestMark } from '../../ui/NestMark';
import { Button, Notice, SegTabs, TextField } from '../../ui/components';
import { IconChevron } from './icons';
import { Picker } from './Picker';
import { ChangePassword } from './ChangePassword';
import { ResetVault } from './ResetVault';

type Tab = 'general' | 'chains' | 'sites';
type Flash = (ok: boolean, err?: string) => void;
const AUTOLOCK_OPTIONS = [5, 15, 30, 60, 240];
const BUY_KEYS = ['1', '2', '3', '4'];
const SELL_KEYS = ['Q', 'W', 'E', 'R'];

/** Shows "Saved" briefly after each auto-save. */
function useSaved(): [string | null, Flash] {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  return [
    msg,
    (ok, err) => {
      setMsg(ok ? 'Saved' : (err ?? 'Not saved'));
      clearTimeout(t.current);
      t.current = setTimeout(() => setMsg(null), 1500);
    },
  ];
}

/** A titled group of settings on one card; `rows` cards divide their rows with lines. */
function Group(props: {
  title: string;
  sub?: string;
  aside?: ComponentChildren;
  rows?: boolean;
  tone?: 'mev' | undefined;
  children: ComponentChildren;
}) {
  return (
    <section class="set-group">
      <div class="set-group-head">
        <h2 class="section-title">{props.title}</h2>
        {props.aside}
      </div>
      {props.sub && <p class="set-sub">{props.sub}</p>}
      <div class={`set-card${props.rows ? ' rows' : ''}${props.tone ? ` ${props.tone}` : ''}`}>
        {props.children}
      </div>
    </section>
  );
}

/** Label and hint on the left of a row. */
function RowText(props: { label: string; hint?: ComponentChildren; error?: string | undefined }) {
  return (
    <span class="set-text">
      <span class="set-label">{props.label}</span>
      {props.hint && <span class="set-hint">{props.hint}</span>}
      {props.error && (
        <span class="error" role="alert">
          {props.error}
        </span>
      )}
    </span>
  );
}

/** A number in a small box at the end of its row; saves on blur when valid. */
function NumRow(props: {
  label: string;
  hint?: ComponentChildren;
  value: number | string;
  prefix?: string;
  suffix?: string;
  decimals?: boolean;
  /** true when saved, else the reason to show. */
  onSave: (v: string) => Promise<true | string>;
}) {
  const [v, setV] = useState(String(props.value));
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => setV(String(props.value)), [props.value]);
  return (
    <label
      class="set-row"
      onFocusOut={async () => {
        const parsed = parseDecimalInput(v);
        if (parsed === null || (!props.decimals && parsed.includes('.'))) {
          setErr('Enter a valid number');
          return;
        }
        setErr(undefined);
        if (parsed === String(props.value)) return;
        const saved = await props.onSave(parsed);
        if (saved !== true) setErr(saved);
      }}
    >
      <RowText label={props.label} hint={props.hint} error={err} />
      <span class="num-box">
        {props.prefix && <span>{props.prefix}</span>}
        <input
          inputMode="decimal"
          value={v}
          aria-invalid={err ? 'true' : undefined}
          onInput={(e) => setV(e.currentTarget.value)}
        />
        {props.suffix && <span>{props.suffix}</span>}
      </span>
    </label>
  );
}

/** An on/off setting with its switch at the end of the row. */
function Toggle(props: {
  label: string;
  hint?: ComponentChildren;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label class="set-row set-toggle">
      <RowText label={props.label} hint={props.hint} />
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

/** One-of-several choice as side-by-side cards. */
function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; sub: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="set-block">
      <span class="set-label">{props.label}</span>
      <div
        class="choice"
        role="radiogroup"
        aria-label={props.label}
        style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}
      >
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            onClick={() => props.value !== o.value && props.onChange(o.value)}
          >
            <b>{o.label}</b>
            <span>{o.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Settings({ onReset }: { onReset: () => void }) {
  const [tab, setTab] = useState<Tab>('general');
  const [saved, flash] = useSaved();
  return (
    <div class="stack settings">
      <header class="set-head">
        <NestMark size={24} />
        <h1>Settings</h1>
        <span class={saved && saved !== 'Saved' ? 'error' : 'hint'} role="status">
          {saved ?? 'Saved automatically'}
        </span>
      </header>
      <SegTabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'general', label: 'General' },
          { value: 'chains', label: 'Chains' },
          { value: 'sites', label: 'Sites' },
        ]}
      />
      <div class="tab-pane" key={tab}>
        {tab === 'general' && <General onReset={onReset} flash={flash} />}
        {tab === 'chains' && <Chains flash={flash} />}
        {tab === 'sites' && <Sites />}
      </div>
    </div>
  );
}

/** Where the impact thresholds sit on a 0 to max scale. */
function ImpactBar({ warnBps, dangerBps }: { warnBps: number; dangerBps: number }) {
  const max = Math.max(1000, dangerBps * 2);
  const at = (bps: number) => `${Math.min(100, (bps / max) * 100)}%`;
  return (
    <div class="impact" aria-hidden="true">
      <div
        class="impact-bar"
        style={{
          background: `linear-gradient(90deg, var(--buy-line) 0 ${at(warnBps)}, #4a3a1a ${at(warnBps)} ${at(dangerBps)}, var(--sell-line) ${at(dangerBps)} 100%)`,
        }}
      >
        <i class="warn" style={{ left: at(warnBps) }} />
        <i class="stop" style={{ left: at(dangerBps) }} />
      </div>
      <div class="impact-scale">
        <span>0%</span>
        <span>{formatPercent(max)}</span>
      </div>
    </div>
  );
}

function General({ onReset, flash }: { onReset: () => void; flash: Flash }) {
  const [s, setS] = useState<GlobalSettings | null>(null);
  const [walletCount, setWalletCount] = useState<number | null>(null);
  const [repaired, setRepaired] = useState<string[]>([]);
  const [resetOpen, setResetOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwChanged, setPwChanged] = useState(false);

  useEffect(() => {
    void send({ type: 'settings.get' }).then((r) => r.ok && setS(r.data));
    void send({ type: 'settings.repairs' }).then((r) => r.ok && setRepaired(r.data));
    void send({ type: 'wallets.list' }).then((r) => r.ok && setWalletCount(r.data.length));
  }, []);
  if (!s) return <p class="muted">Loading…</p>;

  const update = async (patch: Partial<GlobalSettings>): Promise<true | string> => {
    const r = await send({ type: 'settings.update', patch });
    if (r.ok) setS(r.data);
    flash(r.ok, r.ok ? undefined : errorText(r));
    return r.ok ? true : (r.detail ?? errorText(r));
  };

  return (
    <div class="stack set-stack">
      {repaired.length > 0 && (
        <Notice tone="warn">
          Some saved settings were invalid and were reset to their defaults: {repaired.join(', ')}.
          Check them below.
        </Notice>
      )}
      <Group title="Safety limits" sub="Checked before anything is signed. Amounts in USD." rows>
        <NumRow
          label="Per transaction"
          hint="Largest single trade"
          prefix="$"
          value={s.maxUsdPerTx}
          decimals
          onSave={(v) => update({ maxUsdPerTx: Number(v) })}
        />
        <NumRow
          label="Per click, all wallets"
          hint="One click across every selected wallet"
          prefix="$"
          value={s.maxUsdPerClick}
          decimals
          onSave={(v) => update({ maxUsdPerClick: Number(v) })}
        />
        <NumRow
          label="Ask first above"
          hint="Bigger one-click trades wait for a confirm"
          prefix="$"
          value={s.confirmAboveUsd}
          decimals
          onSave={(v) => update({ confirmAboveUsd: Number(v) })}
        />
        <NumRow
          label="Network fee"
          hint="Never sign when gas would cost more"
          prefix="$"
          value={s.maxGasUsd}
          decimals
          onSave={(v) => update({ maxGasUsd: Number(v) })}
        />
      </Group>

      <Group title="Trading">
        <Choice<'each' | 'split'>
          label="With several wallets selected"
          value={s.multiWalletMode}
          onChange={(v) => void update({ multiWalletMode: v })}
          options={[
            { value: 'each', label: 'Each wallet', sub: '0.01 ETH × 3 wallets' },
            { value: 'split', label: 'Split the total', sub: '0.01 ETH ÷ 3 wallets' },
          ]}
        />

        <div class="set-block">
          <div class="set-block-head">
            <span class="set-label">Price impact</span>
            <span class="set-hint">
              Warn at <b class="warn">{formatPercent(s.priceImpactWarnBps)}</b> · stop at{' '}
              <b class="stop">{formatPercent(s.priceImpactDangerBps)}</b>
            </span>
          </div>
          <ImpactBar warnBps={s.priceImpactWarnBps} dangerBps={s.priceImpactDangerBps} />
          <div class="grid2">
            <NumRow
              label="Warn at"
              suffix="%"
              value={s.priceImpactWarnBps / 100}
              decimals
              onSave={(v) => update({ priceImpactWarnBps: Math.round(Number(v) * 100) })}
            />
            <NumRow
              label="Stop at"
              suffix="%"
              value={s.priceImpactDangerBps / 100}
              decimals
              onSave={(v) => update({ priceImpactDangerBps: Math.round(Number(v) * 100) })}
            />
          </div>
        </div>

        <Toggle
          label="Simulate before signing"
          hint="Safer; adds one round trip (~0.2 s)."
          checked={s.simulateBeforeSign}
          onChange={(v) => void update({ simulateBeforeSign: v })}
        />
        <Toggle
          label="Approve each token once"
          hint={
            s.unlimitedApprovals
              ? 'Unlimited, and only to Permit2 or a listed router. Sells never wait for an approval.'
              : 'Each approval covers your holdings plus the headroom below, topped up after every buy.'
          }
          checked={s.unlimitedApprovals}
          onChange={(v) => void update({ unlimitedApprovals: v })}
        />
        {!s.unlimitedApprovals && (
          <NumRow
            label="Approval headroom"
            hint="Margin on top of your holdings"
            suffix="%"
            value={s.approvalBufferBps / 100}
            decimals
            onSave={(v) => update({ approvalBufferBps: Math.round(Number(v) * 100) })}
          />
        )}
        <Toggle
          label="KyberSwap when no listed pool trades"
          hint="Shares token and amount with KyberSwap; its swaps are checked first."
          checked={s.useAggregator}
          onChange={(v) => void update({ useAggregator: v })}
        />
        <Toggle
          label="DEX Screener pool index"
          hint="Finds pools faster; every result is checked on-chain."
          checked={s.usePoolIndex}
          onChange={(v) => void update({ usePoolIndex: v })}
        />
        <Toggle
          label="Logos"
          hint="Token and chain logos from DEX Screener, and Solana coins’ from pump.fun’s IPFS gateway, which then see what you hold."
          checked={s.showTokenLogos}
          onChange={(v) => void update({ showTokenLogos: v })}
        />
        <Toggle
          label="Hotkeys"
          hint="1–4 buy, Q W E R sell. Ignored while typing."
          checked={s.hotkeysEnabled}
          onChange={(v) => void update({ hotkeysEnabled: v })}
        />
        <NumRow
          label="Random delay between wallets"
          hint="0 to 300 ms"
          suffix="ms"
          value={s.jitterMaxMs}
          onSave={(v) => update({ jitterMaxMs: Number(v) })}
        />
        <NumRow
          label="Vary each wallet's buy"
          hint="Up to this much less, at random; 0 to 50%"
          suffix="%"
          value={s.buyVarianceBps / 100}
          decimals
          onSave={(v) => update({ buyVarianceBps: Math.round(Number(v) * 100) })}
        />
      </Group>

      <Group title="Security" rows>
        <div class="set-row">
          <RowText label="Lock after inactivity" hint="Also locks when the browser closes" />
          <Picker
            variant="compact"
            title="Lock after inactivity"
            value={s.autoLockMinutes}
            onChange={(v) => void update({ autoLockMinutes: v })}
            options={AUTOLOCK_OPTIONS.map((m) => ({
              value: m,
              label: m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`,
            }))}
          />
        </div>
        <button
          type="button"
          class="set-row set-link"
          aria-expanded={pwOpen}
          onClick={() => {
            setPwOpen(!pwOpen);
            setPwChanged(false);
          }}
        >
          <RowText label="Change password" hint={pwChanged ? 'Password changed' : undefined} />
          <IconChevron size={14} />
        </button>
        {pwOpen && (
          <ChangePassword
            onDone={() => {
              setPwOpen(false);
              setPwChanged(true);
            }}
          />
        )}
        <button
          type="button"
          class="set-row set-link danger"
          aria-expanded={resetOpen}
          onClick={() => setResetOpen(!resetOpen)}
        >
          <span class="set-label">Remove all wallets from this browser</span>
          <IconChevron size={14} />
        </button>
        {resetOpen && <ResetVault onReset={onReset} walletCount={walletCount} />}
      </Group>
    </div>
  );
}

/** One quick-button value, tinted for its side. */
function QuickInput(props: {
  label: string;
  side: 'buy' | 'sell';
  value: string;
  onSave: (v: string) => Promise<true | string>;
}) {
  const [v, setV] = useState(props.value);
  const [bad, setBad] = useState(false);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <label class={`quick ${props.side}`}>
      <span>{props.label}</span>
      <input
        inputMode="decimal"
        value={v}
        aria-invalid={bad ? 'true' : undefined}
        onInput={(e) => setV(e.currentTarget.value)}
        onBlur={async () => {
          const parsed = parseDecimalInput(v);
          if (parsed === null) {
            setBad(true);
            return;
          }
          if (parsed === props.value) {
            setBad(false);
            return;
          }
          setBad((await props.onSave(parsed)) !== true);
        }}
      />
    </label>
  );
}

function Chains({ flash }: { flash: Flash }) {
  const chains = [...CHAINS.values()];
  const [chainId, setChainId] = useState(chains[0]?.id ?? 1);
  const [s, setS] = useState<ChainSettings | null>(null);
  const chain = chains.find((c) => c.id === chainId);

  useEffect(() => {
    setS(null);
    if (isSolana(chainId)) return;
    void send({ type: 'settings.getChain', chainId }).then((r) => r.ok && setS(r.data));
  }, [chainId]);

  const update = async (patch: Partial<ChainSettings>): Promise<true | string> => {
    const r = await send({ type: 'settings.updateChain', chainId, patch });
    if (r.ok) setS(r.data);
    flash(r.ok, r.ok ? undefined : errorText(r));
    return r.ok ? true : (r.detail ?? errorText(r));
  };

  return (
    <div class="stack set-stack">
      <div class="chain-chips" role="radiogroup" aria-label="Chain">
        {chains.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === chainId}
            onClick={() => setChainId(c.id)}
          >
            {chainLabel(c)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={isSolana(chainId)}
          onClick={() => setChainId(SOLANA_CHAIN_ID)}
        >
          {SOLANA.name}
        </button>
      </div>
      {isSolana(chainId) ? (
        <SolanaChain flash={flash} />
      ) : !s || !chain ? (
        <p class="muted">Loading…</p>
      ) : (
        <>
          <Group
            title="Quick buttons"
            aside={<span class="hint">Also editable from the panel</span>}
          >
            <div class="set-block">
              <span class="quick-title buy">Buy, in {chain.nativeCurrency.symbol}</span>
              <div class="grid4">
                {s.quickBuyAmounts.map((a, i) => (
                  <QuickInput
                    key={`${chainId}-b${i}`}
                    label={`Key ${BUY_KEYS[i]}`}
                    side="buy"
                    value={a}
                    onSave={(v) => {
                      const next = [...s.quickBuyAmounts];
                      next[i] = v;
                      return update({ quickBuyAmounts: next });
                    }}
                  />
                ))}
              </div>
            </div>
            <div class="set-block">
              <span class="quick-title sell">Sell, % of holding</span>
              <div class="grid4">
                {s.quickSellBps.map((bps, i) => (
                  <QuickInput
                    key={`${chainId}-s${i}`}
                    label={`Key ${SELL_KEYS[i]}`}
                    side="sell"
                    value={String(bps / 100)}
                    onSave={(v) => {
                      const next = [...s.quickSellBps];
                      next[i] = Math.round(Number(v) * 100);
                      return update({ quickSellBps: next });
                    }}
                  />
                ))}
              </div>
            </div>
          </Group>

          <Group title="Slippage and gas">
            <NumRow
              key={`slip-${chainId}`}
              label="Default slippage"
              hint="10 / 20 / 40% are one tap away in the panel"
              suffix="%"
              value={s.slippageBps / 100}
              decimals
              onSave={(v) => update({ slippageBps: Math.round(Number(v) * 100) })}
            />
            <NumRow
              key={`tax-${chainId}`}
              label="Max token tax"
              hint="Buys are refused above it; 100 turns it off"
              suffix="%"
              value={s.maxTaxBps / 100}
              decimals
              onSave={(v) => update({ maxTaxBps: Math.round(Number(v) * 100) })}
            />
            {chain.feeModel === 'arbitrum' ? (
              <p class="set-hint">
                Priority fee has no effect on this chain (first-come-first-served sequencer).
              </p>
            ) : (
              <>
                <Choice<ChainSettings['priority']>
                  label="Priority fee"
                  value={s.priority}
                  onChange={(v) => void update({ priority: v })}
                  options={[
                    { value: 'low', label: 'Low', sub: `${s.priorityGwei.low} gwei` },
                    { value: 'medium', label: 'Medium', sub: `${s.priorityGwei.medium} gwei` },
                    { value: 'high', label: 'High', sub: `${s.priorityGwei.high} gwei` },
                    { value: 'custom', label: 'Custom', sub: `${s.customPriorityGwei} gwei` },
                  ]}
                />
                {s.priority === 'custom' && (
                  <NumRow
                    key={`prio-${chainId}`}
                    label="Custom priority fee"
                    suffix="gwei"
                    value={s.customPriorityGwei}
                    decimals
                    onSave={(v) => update({ customPriorityGwei: v })}
                  />
                )}
              </>
            )}
            <NumRow
              key={`mult-${chainId}`}
              label="Max fee headroom"
              hint="× base fee. Only the real fee is paid; at least 1.25"
              suffix="×"
              value={s.maxFeeMultiplier}
              decimals
              onSave={(v) => update({ maxFeeMultiplier: Number(v) })}
            />
          </Group>

          <Group title="MEV protection" tone={chain.mev.supported ? 'mev' : undefined}>
            {chain.mev.supported ? (
              <>
                <Toggle
                  label="Send privately"
                  hint="Trades skip the public mempool, so they cannot be sandwiched."
                  checked={s.mevEnabled}
                  onChange={(v) => void update({ mevEnabled: v })}
                />
                <RpcSetting
                  key={`mev-${chainId}`}
                  label="Private RPC"
                  value={s.mevRpc}
                  placeholder={
                    chain.id === 1
                      ? 'Empty uses Flashbots Protect'
                      : 'Empty uses PancakeSwap MEV Guard'
                  }
                  onSave={(v) => update({ mevRpc: v })}
                />
                {s.mevEnabled && !s.mevRpc && (
                  <Notice tone="warn">
                    MEV protection is on but no private RPC is set, so transactions use the public
                    RPC.
                  </Notice>
                )}
              </>
            ) : (
              <p class="set-hint">{chain.mev.reason} MEV protection is not needed here.</p>
            )}
          </Group>

          <Group title="Network">
            <RpcSetting
              key={`rpc-${chainId}`}
              label="Your RPC (https)"
              value={s.customRpc}
              placeholder={`Optional. Tried before ${new URL(chain.rpcUrls[0] ?? 'https://x').host}`}
              onSave={(v) => update({ customRpc: v })}
            />
            {s.customRpc && <RpcAccess key={`access-${s.customRpc}`} url={s.customRpc} />}
            <RpcSetting
              key={`ws-${chainId}`}
              label="Live blocks (wss)"
              value={s.wsRpc}
              scheme="wss"
              placeholder="Optional. Faster confirmations"
              onSave={(v) => update({ wsRpc: v })}
            />
            {s.wsRpc && <WsStatusLine chainId={chainId} />}
          </Group>

          <Approvals key={`appr-${chainId}`} chainId={chainId} chainName={chain.name} />
        </>
      )}
    </div>
  );
}

/** Solana's own settings: its trades pay a priority fee in SOL, and there is no gas or tax. */
function SolanaChain({ flash }: { flash: Flash }) {
  const [s, setS] = useState<SolanaSettings | null>(null);

  useEffect(() => {
    void send({ type: 'sol.settings.get' }).then((r) => r.ok && setS(r.data));
  }, []);

  const update = async (patch: Partial<SolanaSettings>): Promise<true | string> => {
    const r = await send({ type: 'sol.settings.update', patch });
    if (r.ok) setS(r.data);
    flash(r.ok, r.ok ? undefined : errorText(r));
    return r.ok ? true : (r.detail ?? errorText(r));
  };

  if (!s) return <p class="muted">Loading…</p>;
  const sol = SOLANA.nativeCurrency.symbol;
  return (
    <>
      <Group title="Quick buttons" aside={<span class="hint">Also editable from the panel</span>}>
        <div class="set-block">
          <span class="quick-title buy">Buy, in {sol}</span>
          <div class="grid4">
            {s.quickBuyAmounts.map((a, i) => (
              <QuickInput
                key={`sol-b${i}`}
                label={`Key ${BUY_KEYS[i]}`}
                side="buy"
                value={a}
                onSave={(v) => {
                  const next = [...s.quickBuyAmounts];
                  next[i] = v;
                  return update({ quickBuyAmounts: next });
                }}
              />
            ))}
          </div>
        </div>
        <div class="set-block">
          <span class="quick-title buy">Buy, in USD, for coins paired with a token</span>
          <span class="hint">
            Shown in that token at its price, e.g. in USDC for a coin paired with USDC
          </span>
          <div class="grid4">
            {s.quickBuyUsd.map((a, i) => (
              <QuickInput
                key={`sol-u${i}`}
                label={`Key ${BUY_KEYS[i]}`}
                side="buy"
                value={a}
                onSave={(v) => {
                  const next = [...s.quickBuyUsd];
                  next[i] = v;
                  return update({ quickBuyUsd: next });
                }}
              />
            ))}
          </div>
        </div>
        <div class="set-block">
          <span class="quick-title sell">Sell, % of holding</span>
          <div class="grid4">
            {s.quickSellBps.map((bps, i) => (
              <QuickInput
                key={`sol-s${i}`}
                label={`Key ${SELL_KEYS[i]}`}
                side="sell"
                value={String(bps / 100)}
                onSave={(v) => {
                  const next = [...s.quickSellBps];
                  next[i] = Math.round(Number(v) * 100);
                  return update({ quickSellBps: next });
                }}
              />
            ))}
          </div>
        </div>
      </Group>

      <Group title="Slippage and priority fee">
        <NumRow
          label="Default slippage"
          hint="10 / 20 / 40% are one tap away in the panel"
          suffix="%"
          value={s.slippageBps / 100}
          decimals
          onSave={(v) => update({ slippageBps: Math.round(Number(v) * 100) })}
        />
        <Choice<SolanaSettings['priority']>
          label={`Priority fee, ${sol} per transaction`}
          value={s.priority}
          onChange={(v) => void update({ priority: v })}
          options={[
            { value: 'low', label: 'Low', sub: s.priorityFeeSol.low },
            { value: 'medium', label: 'Medium', sub: s.priorityFeeSol.medium },
            { value: 'high', label: 'High', sub: s.priorityFeeSol.high },
            { value: 'custom', label: 'Custom', sub: s.customPriorityFeeSol },
          ]}
        />
        {s.priority === 'custom' && (
          <NumRow
            label="Custom priority fee"
            hint="Paid on top of the network fee, by each wallet that trades"
            suffix={sol}
            value={s.customPriorityFeeSol}
            decimals
            onSave={(v) => update({ customPriorityFeeSol: v })}
          />
        )}
      </Group>

      <Group title="Network">
        <RpcSetting
          label="Your RPC (https)"
          value={s.customRpc}
          placeholder={`Optional. Tried before ${new URL(SOLANA.rpcUrls[0]).host}`}
          onSave={(v) => update({ customRpc: v })}
        />
        {s.customRpc && <RpcAccess key={`access-${s.customRpc}`} url={s.customRpc} />}
        <p class="set-hint">
          The public endpoints are rate-limited. Your own RPC loads quotes and lands trades faster.
        </p>
      </Group>
    </>
  );
}

/**
 * Standing token approvals on this chain: what each wallet lets Permit2, a router or a
 * launchpad move. Revoking sets one back to zero (a small network fee).
 */
function Approvals({ chainId, chainName }: { chainId: number; chainName: string }) {
  const [list, setList] = useState<ApprovalView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The row being confirmed, or being revoked. */
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setList(null);
    setErr(null);
    void send({ type: 'approvals.list', chainId }).then((r) => {
      if (r.ok)
        setList(
          [...r.data].sort(
            (a, b) => Number(b.unlimited) - Number(a.unlimited) || a.symbol.localeCompare(b.symbol),
          ),
        );
      else {
        setList([]);
        setErr(errorText(r));
      }
    });
  };
  useEffect(load, [chainId]);

  const keyOf = (a: ApprovalView) => `${a.walletId}:${a.token}:${a.spender}`;
  const revoke = async (a: ApprovalView) => {
    const k = keyOf(a);
    setBusy(k);
    setAsking(null);
    setErr(null);
    const r = await send({
      type: 'approvals.revoke',
      chainId,
      walletId: a.walletId,
      token: a.token as Address,
      spender: a.spender as Address,
    });
    setBusy(null);
    if (!r.ok) return setErr(errorText(r));
    if (r.data.confirmed) setList((l) => (l ?? []).filter((x) => keyOf(x) !== k));
    else setErr('Revoke sent but not confirmed yet. Check again in a minute.');
  };

  return (
    <Group
      title="Token approvals"
      sub={`What your wallets let Permit2, routers and launchpads spend on ${chainName}.`}
      aside={
        <button type="button" class="link" disabled={list === null} onClick={load}>
          Check again
        </button>
      }
      rows
    >
      {list === null ? (
        [0, 1, 2].map((i) => (
          <div key={i} class="set-row appr-skel" aria-hidden="true">
            <span class="skel skel--name" />
            <span class="skel skel--val" />
          </div>
        ))
      ) : list.length === 0 ? (
        <p class="set-hint appr-empty">{err ?? `No approvals left open on ${chainName}.`}</p>
      ) : (
        list.map((a) => {
          const k = keyOf(a);
          return (
            <div key={k} class="set-row appr">
              <RowText
                label={`${a.symbol} · ${a.unlimited ? 'Unlimited' : formatToken(BigInt(a.amount), a.decimals)}`}
                hint={
                  <>
                    {a.spenderLabel} · {a.walletName}
                  </>
                }
              />
              {asking === k ? (
                <span class="appr-ask">
                  <button type="button" class="btn btn--sm" onClick={() => setAsking(null)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    onClick={() => void revoke(a)}
                  >
                    Revoke
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={busy !== null}
                  title="Set this allowance back to zero. Costs a small network fee."
                  onClick={() => setAsking(k)}
                >
                  {busy === k ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </div>
          );
        })
      )}
      {err && list !== null && list.length > 0 && (
        <p class="error appr-err" role="alert">
          {err}
        </p>
      )}
    </Group>
  );
}

function WsStatusLine({ chainId }: { chainId: number }) {
  const [st, setSt] = useState<WsStatusView | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void send({ type: 'ws.status', chainId }).then((r) => alive && r.ok && setSt(r.data));
    poll();
    const id = setInterval(poll, 2_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [chainId]);
  if (!st) return null;
  const text =
    st.state === 'connected'
      ? 'Connected · new blocks streaming'
      : st.state === 'connecting'
        ? 'Connecting…'
        : st.state === 'error'
          ? 'Connection error — using HTTPS polling'
          : 'Off';
  return (
    <span class={`ws-status ws-${st.state}`} role="status">
      <span class="ws-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function RpcSetting(props: {
  label: string;
  value: string;
  placeholder: string;
  scheme?: 'https' | 'wss';
  onSave: (v: string) => Promise<true | string>;
}) {
  const scheme = props.scheme ?? 'https';
  const [v, setV] = useState(props.value);
  const [err, setErr] = useState<string | undefined>();
  return (
    <div
      onFocusOut={async () => {
        const t = v.trim();
        if (t === props.value) return;
        if (t && !new RegExp(`^${scheme}://[^\\s]+$`).test(t)) {
          setErr(`Must start with ${scheme}://`);
          return;
        }
        setErr(undefined);
        if ((await props.onSave(t)) !== true) setErr('Invalid URL');
      }}
    >
      <TextField
        label={props.label}
        value={v}
        onInput={setV}
        placeholder={props.placeholder}
        error={err}
        mono
      />
    </div>
  );
}

/**
 * Without host access Chrome sends a CORS preflight before the first request on each
 * new connection (and again when its cache expires): a whole extra round trip.
 */
function RpcAccess({ url }: { url: string }) {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!origin) return;
    void browser.permissions.contains({ origins: [`${origin}/*`] }).then(setGranted);
  }, [origin]);

  if (!origin || granted === null) return null;
  if (granted) return <p class="hint">Direct connection allowed.</p>;
  return (
    <div class="stack">
      <p class="hint">
        Allow direct access to skip the extra check Chrome makes on each new connection to this RPC.
        That saves one round trip on the first trade after a pause.
      </p>
      <Button
        onClick={async () => {
          // Must run in the click handler (user gesture) for Chrome to show the prompt.
          setGranted(await browser.permissions.request({ origins: [`${origin}/*`] }));
        }}
      >
        Allow direct access
      </Button>
    </div>
  );
}

function Sites() {
  const [tab, setTab] = useState<{ id: number; origin: string } | null>(null);
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(async ([t]) => {
      if (!t?.id || !t.url) return;
      let origin: string;
      try {
        const u = new URL(t.url);
        if (u.protocol !== 'https:' && !isNestySite(u.origin)) return;
        origin = u.origin;
      } catch {
        return;
      }
      setTab({ id: t.id, origin });
      const r = await send({ type: 'sites.status', origin });
      if (r.ok) setStatus(r.data);
    });
  }, []);

  const enable = async () => {
    if (!tab) return;
    setError(null);
    // Must run in the click handler (user gesture) for Chrome to show the prompt.
    const granted = await browser.permissions.request({ origins: [`${tab.origin}/*`] });
    if (!granted) {
      setError('Permission was not granted.');
      return;
    }
    const r = await send({ type: 'sites.enable', origin: tab.origin, tabId: tab.id });
    if (r.ok) setStatus(r.data);
    else setError(errorText(r));
  };

  const disable = async () => {
    if (!tab) return;
    const r = await send({ type: 'sites.disable', origin: tab.origin });
    if (r.ok) setStatus(r.data);
    else setError(errorText(r));
  };

  return (
    <div class="stack">
      <p class="muted">
        Nesty runs on GMGN, DEX Screener, DEXTools, GeckoTerminal, Birdeye, Axiom, BasedBot,
        four.meme and Flap out of the box. You can enable it on any other trading site here; the
        token is read from the page URL.
      </p>
      {!tab ? (
        <Notice>Open a trading site in this tab, then come back here.</Notice>
      ) : (
        <div class="card" style={{ padding: '12px', display: 'grid', gap: '8px' }}>
          <span class="mono" style={{ wordBreak: 'break-all' }}>
            {tab.origin}
          </span>
          {isNestySite(tab.origin) ? (
            <span class="hint">
              The Nesty website: no panel here. The site trades on its own and asks Nesty to sign.
            </span>
          ) : status?.builtin ? (
            <span class="hint">Built-in site — always enabled.</span>
          ) : status?.enabled ? (
            <Button size="sm" onClick={() => void disable()} style={{ justifySelf: 'start' }}>
              Disable on this site
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void enable()}
              style={{ justifySelf: 'start' }}
            >
              Enable on this site
            </Button>
          )}
        </div>
      )}
      {error && <p class="error">{error}</p>}
      <SiteConnections />
    </div>
  );
}

/** Sites the user connected: they see the wallets' addresses and ask for trades to be signed. */
function SiteConnections() {
  const [list, setList] = useState<{ origin: string; at: number }[]>([]);
  const load = () => {
    void send({ type: 'site.connections' }).then((r) => setList(r.ok ? r.data : []));
  };
  useEffect(load, []);
  if (list.length === 0) return null;
  return (
    <div class="card" style={{ padding: '12px', display: 'grid', gap: '8px' }}>
      <span class="set-label">Connected to the Nesty website</span>
      <span class="hint">
        It sees your wallets' addresses and asks Nesty to sign its trades, each checked against your
        safety limits. It never sees a key and cannot send funds.
      </span>
      {list.map((c) => (
        <div class="row" key={c.origin}>
          <span class="mono" style={{ wordBreak: 'break-all' }}>
            {c.origin}
          </span>
          <span class="spacer" />
          <Button
            size="sm"
            onClick={() => void send({ type: 'site.revoke', origin: c.origin }).then(load)}
          >
            Disconnect
          </Button>
        </div>
      ))}
    </div>
  );
}
