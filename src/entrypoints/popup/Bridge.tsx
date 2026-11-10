import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import { formatCompact, formatUsd, parseDecimalInput } from '../../shared/format';
import type { BridgeQuoteView, PushEvent } from '../../shared/messages';
import { bridgeGasReserve, nativeSymbol, networkName } from '../../shared/networks';
import type { TradeTicket } from '../../shared/panel';
import {
  SOLANA,
  SOLANA_CHAIN_ID,
  isSolAddress,
  isSolana,
  nativeDecimals,
} from '../../shared/solana';
import { fallbackWallet, shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Notice, PasswordField, TextField } from '../../ui/components';
import { statusOf } from './Activity';
import { IconSwap } from './icons';
import { ChainMark, Picker } from './Picker';
import { txUrl } from './links';

/** Relay's refusals arrive as no_route, whose usual wording is about a token's liquidity. */
const bridgeError = (r: Parameters<typeof errorText>[0]) =>
  r.error === 'no_route' ? `No bridge route.${r.detail ? ` ${r.detail}` : ''}` : errorText(r);

/** A wallet's address on a network: its Solana one there, its EVM one elsewhere. */
const addressOn = (a: WalletAccount, chainId: number) => (isSolana(chainId) ? a.solana : a.address);

const NETWORKS = [
  ...[...CHAINS.values()].map((c) => ({ id: c.id, name: c.name })),
  { id: SOLANA_CHAIN_ID, name: SOLANA.name },
];

/** "Receive in" set to an address typed rather than one of the wallets. */
const ADDRESS = 'address';

type Check = { tone: 'warn' | 'bad' | 'info'; text: string };

/**
 * What is known of an address typed to receive: refused where the coin would be lost,
 * warned where it may be. The engine refuses the same addresses again.
 */
function useAddressChecks(chainId: number, address: string | null): Check[] {
  const [checks, setChecks] = useState<Check[]>([]);
  useEffect(() => {
    setChecks([]);
    if (!address) return;
    let alive = true;
    const coin = `${nativeSymbol(chainId)} on ${networkName(chainId)}`;
    const t = setTimeout(async () => {
      const out: Check[] = [];
      if (isSolana(chainId)) {
        const r = await send({ type: 'sol.send.checkRecipient', to: address });
        if (!alive || !r.ok) return;
        const c = r.data;
        if (c.kind === 'program' || c.kind === 'mint' || c.kind === 'token-account')
          out.push({
            tone: 'bad',
            text: 'This address is not a wallet: funds sent there are lost.',
          });
        else if (c.kind === 'program-account')
          out.push({
            tone: 'warn',
            text: `A program holds this address, like an exchange deposit or a multisig vault. Continue only if it accepts ${coin}.`,
          });
        if (c.ownName) out.push({ tone: 'info', text: `This is your wallet "${c.ownName}".` });
        else if (c.kind === 'unused')
          out.push({
            tone: 'warn',
            text: 'Nothing was ever sent to this address. Check it is right.',
          });
        else if (!c.sentBefore)
          out.push({ tone: 'warn', text: 'First time sending to this address.' });
      } else {
        const r = await send({ type: 'send.checkRecipient', chainId, to: address as Address });
        if (!alive || !r.ok) return;
        const c = r.data;
        if (c.tokenSymbol)
          out.push({
            tone: 'bad',
            text: `This is the ${c.tokenSymbol} token contract. Funds sent here are lost.`,
          });
        else if (c.contract)
          out.push({
            tone: 'warn',
            text: `This is a contract. Continue only if it accepts ${coin}, like an exchange deposit or smart wallet.`,
          });
        if (c.ownName) out.push({ tone: 'info', text: `This is your wallet "${c.ownName}".` });
        else if (!c.sentBefore)
          out.push({ tone: 'warn', text: 'First time sending to this address.' });
      }
      setChecks(out);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [chainId, address]);
  return checks;
}

export function Bridge({
  accounts,
  defaultChainId,
}: {
  accounts: WalletAccount[];
  defaultChainId: number;
}) {
  const [fromChain, setFromChain] = useState(defaultChainId);
  const [toChain, setToChain] = useState(NETWORKS.find((n) => n.id !== defaultChainId)?.id ?? 1);
  // Each side lists the wallets with an address on its network.
  const fromUsable = accounts.filter((a) => addressOn(a, fromChain));
  const toUsable = accounts.filter((a) => addressOn(a, toChain));
  const [fromWallet, setFromWallet] = useState(fallbackWallet(fromUsable)?.id ?? '');
  // No wallet with an address on the destination network: an address typed is the way left.
  const [toWallet, setToWallet] = useState(fallbackWallet(toUsable)?.id ?? ADDRESS);
  const [amount, setAmount] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<BridgeQuoteView | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TradeTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  // An address typed is shown in full once more before anything is sent to it.
  const [review, setReview] = useState(false);

  const fromSym = nativeSymbol(fromChain);
  const toSym = nativeSymbol(toChain);
  const fromDecimals = nativeDecimals(fromChain);
  const toDecimals = nativeDecimals(toChain);
  const fmt = (raw: bigint, decimals: number) => formatCompact(Number(formatUnits(raw, decimals)));
  const balance = BigInt(balances[fromWallet] ?? '0');
  const parsed = parseDecimalInput(amount);
  const tooPrecise = parsed !== null && (parsed.split('.')[1]?.length ?? 0) > fromDecimals;
  const amountRaw = parsed && !tooPrecise ? parseUnits(parsed, fromDecimals) : null;
  const tooMuch = amountRaw !== null && amountRaw > balance;

  // An address typed to receive: one of the destination chain, with a valid checksum when
  // it is written in mixed case.
  const toTyped = toWallet === ADDRESS;
  const typedTrim = typed.trim();
  const typedAddress =
    !toTyped || typedTrim === ''
      ? null
      : isSolana(toChain)
        ? isSolAddress(typedTrim)
          ? typedTrim
          : null
        : isAddress(typedTrim, { strict: true })
          ? getAddress(typedTrim)
          : null;
  const found = useAddressChecks(toChain, typedAddress);
  const checks: Check[] =
    toTyped && typedTrim !== '' && !typedAddress
      ? [
          {
            tone: 'bad',
            text: isSolana(toChain) ? 'Not a valid Solana address.' : 'Not a valid address.',
          },
        ]
      : found;
  const refused = checks.some((c) => c.tone === 'bad');
  const dest = toTyped
    ? typedAddress
      ? { toAddress: typedAddress }
      : null
    : toUsable.some((a) => a.id === toWallet)
      ? { toWalletId: toWallet }
      : null;

  useEffect(() => {
    setBalances({});
    void send({ type: 'wallets.balances', chainId: fromChain }).then((r) => {
      if (r.ok) setBalances(Object.fromEntries(r.data.map((b) => [b.id, b.native])));
    });
  }, [fromChain, ticket?.status]);

  // Another network may not have the wallets picked: fall back to one with an address on it.
  useEffect(() => {
    if (!fromUsable.some((a) => a.id === fromWallet))
      setFromWallet(fallbackWallet(fromUsable)?.id ?? '');
  }, [fromChain]);
  useEffect(() => {
    if (toWallet !== ADDRESS && !toUsable.some((a) => a.id === toWallet))
      setToWallet(fallbackWallet(toUsable)?.id ?? ADDRESS);
  }, [toChain]);

  // Live progress for the bridge started here.
  useEffect(() => {
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = m as PushEvent;
      if (ev?.kind === 'nesty.ticket')
        setTicket((t) => (t && t.id === ev.ticket.id ? ev.ticket : t));
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Quote as you type (debounced).
  const req = useMemo(
    () =>
      parsed &&
      amountRaw !== null &&
      amountRaw > 0n &&
      fromChain !== toChain &&
      fromUsable.some((a) => a.id === fromWallet) &&
      dest
        ? {
            fromChainId: fromChain,
            toChainId: toChain,
            amount: parsed,
            fromWalletId: fromWallet,
            ...dest,
          }
        : null,
    [parsed, amountRaw, fromChain, toChain, fromWallet, toWallet, typedAddress, accounts],
  );
  useEffect(() => {
    setQuote(null);
    setError(null);
    setConfirm(null);
    setNeedPassword(false);
    setReview(false);
    if (!req) return;
    let alive = true;
    setQuoting(true);
    const t = setTimeout(async () => {
      const r = await send({ type: 'bridge.quote', ...req });
      if (!alive) return;
      setQuoting(false);
      if (r.ok) setQuote(r.data);
      else setError(bridgeError(r));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [req && JSON.stringify(req)]);

  const flip = () => {
    setFromChain(toChain);
    setToChain(fromChain);
  };

  const max = async () => {
    // Solana: everything the network fee leaves, or nothing if that is below what a wallet
    // must keep to exist (Send works it out the same way).
    if (isSolana(fromChain)) {
      const r = await send({ type: 'sol.send.prepare', walletId: fromWallet });
      if (r.ok) setAmount(formatUnits(BigInt(r.data.maxAmount), fromDecimals));
      else setError(errorText(r));
      return;
    }
    const v = balance - bridgeGasReserve(fromChain);
    setAmount(v > 0n ? formatUnits(v, fromDecimals) : '0');
  };

  const run = async (confirmed: boolean) => {
    if (!req) return;
    setBusy(true);
    setError(null);
    const r = await send({
      type: 'bridge.execute',
      ...req,
      confirmed,
      ...(needPassword && password ? { password } : {}),
    });
    setBusy(false);
    if (r.ok) {
      setConfirm(null);
      setReview(false);
      setTicket(r.data);
      setAmount('');
      setPassword('');
      setNeedPassword(false);
    } else if (r.error === 'needs_confirmation') setConfirm(r.detail ?? '');
    // An outside address above the confirmation amount: like a Send, it takes the password.
    else if (r.error === 'needs_password') {
      setNeedPassword(true);
      setError('Enter your password to bridge this.');
    } else setError(bridgeError(r));
  };

  const cancelReview = () => {
    setReview(false);
    setNeedPassword(false);
    setPassword('');
    setError(null);
  };

  const walletSelect = (
    usable: WalletAccount[],
    chainId: number,
    value: string,
    onChange: (v: string) => void,
    title: string,
    showBalance: boolean,
    orAddress = false,
  ) => (
    <Picker
      title={title}
      variant="compact"
      value={value}
      onChange={onChange}
      options={[
        ...usable
          .filter((a) => !a.hidden)
          .map((a) => {
            const address = shortAddress(addressOn(a, chainId) ?? '');
            return {
              value: a.id,
              label: a.name,
              sub: showBalance
                ? `${address} · ${fmt(BigInt(balances[a.id] ?? '0'), fromDecimals)} ${fromSym}`
                : address,
            };
          }),
        ...(orAddress ? [{ value: ADDRESS, label: 'Another address' }] : []),
      ]}
    />
  );

  const chainSelect = (
    value: number,
    onChange: (v: number) => void,
    title: string,
    exclude: number,
    excludeNote: string,
  ) => (
    <Picker
      title={title}
      variant="compact"
      value={value}
      onChange={onChange}
      options={NETWORKS.map((n) => ({
        value: n.id,
        label: n.name,
        sub: nativeSymbol(n.id),
        mark: <ChainMark chainId={n.id} />,
        disabled: n.id === exclude,
        disabledNote: excludeNote,
      }))}
    />
  );

  const st = ticket ? statusOf(ticket) : null;
  // The deposit leg itself: a bridge that swaps first has the swap's hash before it.
  const depositLeg = ticket?.legs.find((l) => l.kind === 'bridge');
  const deposit = depositLeg?.hash ?? depositLeg?.sig;
  // Keys imported from one family have no address on the other.
  const missing = fromUsable.length === 0 ? fromChain : null;

  return (
    <div class="stack" style={{ gap: '8px' }}>
      <div class="card leg">
        <div class="row">
          <span class="section-title">From</span>
          <span class="spacer" />
          <span class="hint">
            Balance {fmt(balance, fromDecimals)} {fromSym}
          </span>
          <button type="button" class="link" onClick={() => void max()}>
            MAX
          </button>
        </div>
        <div class="row">
          <input
            class="amt-input"
            aria-label={`Amount in ${fromSym}`}
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onInput={(e) => setAmount(e.currentTarget.value)}
          />
          {chainSelect(fromChain, setFromChain, 'Bridge from', toChain, 'Selected as destination')}
        </div>
        <div class="row">
          <span class="hint">
            {quote?.amountInUsd != null ? `≈ ${formatUsd(quote.amountInUsd)}` : ''}
          </span>
          <span class="spacer" />
          {walletSelect(fromUsable, fromChain, fromWallet, setFromWallet, 'Send from', true)}
        </div>
      </div>

      <button type="button" class="swap" aria-label="Swap chains" onClick={flip}>
        <IconSwap size={16} />
      </button>

      <div class="card leg">
        <div class="row">
          <span class="section-title">To</span>
        </div>
        <div class="row">
          <span class="amt-out">
            {quote ? fmt(BigInt(quote.amountOut), toDecimals) : quoting ? '…' : '0.0'}
          </span>
          <span class="spacer" />
          {chainSelect(toChain, setToChain, 'Bridge to', fromChain, 'Selected as source')}
        </div>
        <div class="row">
          <span class="hint">{toSym}</span>
          <span class="spacer" />
          {walletSelect(toUsable, toChain, toWallet, setToWallet, 'Receive in', false, true)}
        </div>
        {toTyped && (
          <TextField
            label={`Address on ${networkName(toChain)}`}
            value={typed}
            onInput={setTyped}
            placeholder={isSolana(toChain) ? 'Solana address' : '0x…'}
            mono
            maxLength={64}
          />
        )}
      </div>

      {toTyped && checks.length > 0 && (
        <ul class="checks">
          {checks.map((c) => (
            <li key={c.text} class={`chk chk--${c.tone}`}>
              {c.text}
            </li>
          ))}
        </ul>
      )}

      {quote && (
        <div class="card quote">
          <div class="row">
            <span class="muted">Fee</span>
            <span class="spacer" />
            <span>{quote.feeUsd != null ? formatUsd(quote.feeUsd) : '–'}</span>
          </div>
          <div
            class="row"
            title={`The bridge pays out at least this (${quote.slippageBps / 100}% slippage) or refunds the deposit.`}
          >
            <span class="muted">Minimum received</span>
            <span class="spacer" />
            <span>
              {fmt(BigInt(quote.minOut), toDecimals)} {toSym}
            </span>
          </div>
          <div class="row">
            <span class="muted">Estimated time</span>
            <span class="spacer" />
            <span>
              {quote.timeEstimateS != null
                ? `~${Math.max(1, Math.round(quote.timeEstimateS))} s`
                : '–'}
            </span>
          </div>
        </div>
      )}

      {confirm !== null ? (
        <div class="notice notice--warn" role="alertdialog">
          Bridge about {confirm}? This is above your confirmation threshold.
          <div class="row" style={{ marginTop: '8px' }}>
            <button type="button" class="btn btn--sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" class="btn btn--sm btn--primary" onClick={() => void run(true)}>
              Confirm
            </button>
          </div>
        </div>
      ) : review && typedAddress ? (
        <div class="card leg" role="alertdialog" aria-label="Check the address">
          <span class="muted">
            Bridge {parsed} {fromSym} to this address on {networkName(toChain)}
          </span>
          <span class="address">{typedAddress}</span>
          <Notice tone="warn">
            None of your wallets. Check every character: a bridge cannot be undone.
          </Notice>
          {needPassword && (
            <PasswordField label="Password" value={password} onInput={setPassword} autoFocus />
          )}
          <div class="row">
            <button type="button" class="btn btn--sm" onClick={cancelReview}>
              Cancel
            </button>
            <span class="spacer" />
            <button
              type="button"
              class="btn btn--sm btn--primary"
              disabled={busy || (needPassword && !password)}
              onClick={() => void run(true)}
            >
              {busy ? 'Sending…' : 'Bridge'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          class="btn btn--primary btn--block"
          style={{ height: '40px' }}
          disabled={!quote || busy || quoting || tooMuch || tooPrecise || refused}
          onClick={() => (toTyped ? setReview(true) : void run(false))}
        >
          {tooMuch
            ? 'Insufficient balance'
            : busy
              ? 'Sending…'
              : `Bridge ${parsed ?? ''} ${fromSym}`}
        </button>
      )}

      {tooPrecise && (
        <p class="error" role="alert">
          {fromSym} has {fromDecimals} decimals at most.
        </p>
      )}
      {missing !== null && (
        <p class="error" role="alert">
          No wallet has a {networkName(missing)} address: keys imported from{' '}
          {isSolana(missing) ? 'an EVM' : 'a Solana'} wallet have none.
        </p>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {ticket && st && (
        <div class="card quote" role="status">
          <div class="row">
            <strong>Bridge</strong>
            <span class="spacer" />
            <span class={st.cls}>{st.text}</span>
          </div>
          {deposit && (
            <a href={txUrl(ticket.chainId, deposit)} target="_blank" rel="noopener noreferrer">
              Deposit transaction ↗
            </a>
          )}
          {ticket.bridge?.outHash && (
            <a
              href={txUrl(ticket.bridge.toChainId, ticket.bridge.outHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Received on {networkName(ticket.bridge.toChainId)} ↗
            </a>
          )}
          {ticket.legs.find((l) => l.error)?.error && (
            <span class="error">{ticket.legs.find((l) => l.error)?.error}</span>
          )}
        </div>
      )}

      <p class="hint" style={{ textAlign: 'center' }}>
        Your USD limits apply.
      </p>
    </div>
  );
}
