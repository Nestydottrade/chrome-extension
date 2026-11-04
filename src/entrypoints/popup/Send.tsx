import { useEffect, useRef, useState } from 'preact/hooks';
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { CHAINS } from '../../shared/chains';
import { formatCompact, formatUsd, parseDecimalInput } from '../../shared/format';
import type { Portfolio, RecipientCheck, SendPrep, SolRecipientCheck } from '../../shared/messages';
import type { GlobalSettings } from '../../shared/settings/defaults';
import {
  SOLANA,
  SOLANA_CHAIN_ID,
  isSolAddress,
  isSolana,
  nativeDecimals,
} from '../../shared/solana';
import { fallbackWallet, shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, PasswordField, TextField } from '../../ui/components';
import { ChainMark, Picker } from './Picker';

const NATIVE = 'native';
/** Lamports an account must keep to exist on Solana: a send may empty it, not go below. */

/** Splits an address into groups of four so it can be checked by eye. */
function grouped(a: string): string {
  const evm = a.startsWith('0x');
  const groups = (evm ? a.slice(2) : a).match(/.{1,4}/g)?.join(' ') ?? '';
  return evm ? `0x ${groups}` : groups;
}

type Check = { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string };

/**
 * Send native or a token to any address, on an EVM chain or Solana. Two steps: the form,
 * then a review screen with the full address. The background re-checks everything and
 * asks for the password above the confirmation threshold.
 */
export function Send({
  accounts,
  defaultChainId,
  initialWalletId,
  initialToken,
  onSent,
}: {
  accounts: WalletAccount[];
  defaultChainId: number;
  initialWalletId: string | null;
  /** Start on this token instead of the native asset. */
  initialToken?: string | undefined;
  onSent: (ticketId: string) => void;
}) {
  const chains = [...CHAINS.values()];
  const [chainId, setChainId] = useState(defaultChainId);
  const sol = isSolana(chainId);
  // Each network sends from the wallets with an address on it.
  const addressOf = (a: WalletAccount) => (sol ? a.solana : a.address);
  const usable = accounts.filter((a) => addressOf(a));
  const visible = usable.filter((a) => !a.hidden || a.id === initialWalletId);
  const fallback = fallbackWallet(usable);
  const [walletId, setWalletId] = useState(initialWalletId ?? fallback?.id ?? '');
  const [asset, setAsset] = useState<string>(initialToken ?? NATIVE);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [prep, setPrep] = useState<SendPrep | null>(null);
  const [check, setCheck] = useState<RecipientCheck | null>(null);
  const [solCheck, setSolCheck] = useState<SolRecipientCheck | null>(null);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chain = chains.find((c) => c.id === chainId);
  const networkName = sol ? SOLANA.name : chain?.name;
  const sym = sol ? SOLANA.nativeCurrency.symbol : (chain?.nativeCurrency.symbol ?? 'ETH');
  const nd = nativeDecimals(chainId);
  const wallet = usable.find((a) => a.id === walletId);

  // On a network the picked wallet has no address on, start from that network's default.
  useEffect(() => {
    if (!wallet) setWalletId(fallback?.id ?? '');
  }, [chainId]);

  useEffect(() => {
    void send({ type: 'settings.get' }).then((r) => r.ok && setSettings(r.data));
  }, []);

  useEffect(() => {
    setPortfolio(null);
    if (!wallet) return;
    void send({ type: 'portfolio.get', chainId, walletIds: [walletId] }).then(
      (r) => r.ok && setPortfolio(r.data),
    );
  }, [chainId, walletId]);

  // A token held on one chain or wallet may not exist on the next. Not on opening: the
  // screen may start on a token.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) setAsset(NATIVE);
    opened.current = true;
  }, [chainId, walletId]);

  useEffect(() => {
    setPrep(null);
    if (!wallet) return;
    const token = asset !== NATIVE ? asset : undefined;
    const req = sol
      ? send({ type: 'sol.send.prepare', walletId, ...(token ? { mint: token } : {}) })
      : send({
          type: 'send.prepare',
          chainId,
          walletId,
          ...(token ? { token: token as Address } : {}),
        });
    void req.then((r) => r.ok && setPrep(r.data));
  }, [chainId, walletId, asset]);

  const toTrim = to.trim();
  const validTo = sol ? isSolAddress(toTrim) : isAddress(toTrim, { strict: true });
  // Mixed case that fails the checksum usually means a typo (base58 has no checksum).
  const badChecksum =
    !sol &&
    !validTo &&
    isAddress(toTrim, { strict: false }) &&
    /[A-F]/.test(toTrim) &&
    /[a-f]/.test(toTrim);
  const toAddr = validTo ? (sol ? toTrim : getAddress(toTrim)) : null;

  useEffect(() => {
    setCheck(null);
    setSolCheck(null);
    if (!toAddr) return;
    const id = setTimeout(() => {
      if (sol)
        void send({
          type: 'sol.send.checkRecipient',
          to: toAddr,
          ...(asset !== NATIVE ? { mint: asset } : {}),
        }).then((r) => r.ok && setSolCheck(r.data));
      else
        void send({ type: 'send.checkRecipient', chainId, to: toAddr as Address }).then(
          (r) => r.ok && setCheck(r.data),
        );
    }, 300);
    return () => clearTimeout(id);
    // On Solana the check also says whether the recipient holds the token yet.
  }, [toAddr, chainId, sol && asset]);
  const checked = sol ? solCheck !== null : check !== null;

  const token = asset === NATIVE ? null : portfolio?.tokens.find((t) => t.address === asset);
  const decimals = token ? token.decimals : nd;
  const unit = token ? token.symbol : sym;
  const held = token
    ? BigInt(token.perWallet[walletId] ?? '0')
    : BigInt(portfolio?.native[walletId] ?? '0');

  const parsed = parseDecimalInput(amount);
  let raw: bigint | null = null;
  try {
    raw = parsed ? parseUnits(parsed, decimals) : null;
  } catch {
    raw = null;
  }
  const max = prep ? BigInt(prep.maxAmount) : null;
  const tooMuch = raw !== null && max !== null && raw > max;
  // Solana deletes an account below its rent exemption, so a send can't leave a little.
  const minBalance = sol && prep?.minBalance ? BigInt(prep.minBalance) : 0n;
  const left = raw !== null && max !== null && !tooMuch ? max - raw : 0n;
  const strands = sol && asset === NATIVE && left > 0n && left < minBalance;
  // So little that the fee would leave it below that: nothing can be sent at all.
  const dust = sol && asset === NATIVE && max === 0n && held > 0n;

  const nativeUsd = portfolio?.nativeUsd ?? null;
  const usd =
    raw === null
      ? null
      : token
        ? token.valueUsd !== null && BigInt(token.total) > 0n
          ? (token.valueUsd * Number(formatUnits(raw, decimals))) /
            Number(formatUnits(BigInt(token.total), decimals))
          : null
        : nativeUsd !== null
          ? Number(formatUnits(raw, nd)) * nativeUsd
          : null;
  const feeWei = prep ? BigInt(prep.feeWei) : null;
  const feeText =
    feeWei === null
      ? '…'
      : `${formatCompact(Number(formatUnits(feeWei, nd)))} ${sym}${
          nativeUsd !== null ? ` (${formatUsd(Number(formatUnits(feeWei, nd)) * nativeUsd)})` : ''
        }`;
  const solAmount = (lamports: bigint) => formatUnits(lamports, SOLANA.nativeCurrency.decimals);

  const checks: Check[] = [];
  if (badChecksum)
    checks.push({ tone: 'bad', text: 'Checksum does not match. Check the address for typos.' });
  else if (toTrim && !validTo)
    checks.push({
      tone: 'bad',
      text: sol ? 'Not a valid Solana address.' : 'Not a valid address.',
    });
  if (toAddr) checks.push({ tone: 'ok', text: 'Valid address' });
  if (sol && solCheck) {
    const c = solCheck;
    if (c.kind === 'program')
      checks.push({
        tone: 'bad',
        text: 'This is a program, not a wallet. Funds sent here are lost.',
      });
    else if (c.kind === 'mint')
      checks.push({
        tone: 'bad',
        text: `This is the ${c.mintSymbol ?? 'token'} mint, not a wallet. Funds sent here are lost.`,
      });
    else if (c.kind === 'token-account')
      checks.push({
        tone: 'bad',
        text: `This is a token account, not a wallet.${c.owner ? ` Send to the wallet that owns it: ${shortAddress(c.owner)}.` : ''}`,
      });
    else if (c.kind === 'program-account')
      checks.push({
        tone: 'warn',
        text: `A program holds this address, like an exchange deposit or a multisig vault. Continue only if it accepts ${unit} on Solana.`,
      });
    if (c.kind === 'unused' && asset === NATIVE && raw !== null && raw > 0n && raw < minBalance)
      checks.push({
        tone: 'bad',
        text: `A new address needs at least ${solAmount(minBalance)} SOL to exist.`,
      });
    if (c.tokenAccountRent && c.tokenAccountRent !== '0')
      checks.push({
        tone: 'info',
        text: `The recipient has no ${unit} account yet. Opening it costs ${solAmount(BigInt(c.tokenAccountRent))} SOL, paid by you.`,
      });
    if (c.ownName)
      checks.push({
        tone: 'info',
        text: `This is your wallet "${c.ownName}". Fund and Collect move funds between your wallets.`,
      });
    else if (c.kind === 'unused')
      checks.push({
        tone: 'warn',
        text: 'Nothing was ever sent to this address. Check it is right.',
      });
    else if (!c.sentBefore)
      checks.push({ tone: 'warn', text: 'First time sending to this address.' });
  } else if (!sol && check) {
    if (check.tokenSymbol)
      checks.push({
        tone: 'bad',
        text: `This is the ${check.tokenSymbol} token contract. Funds sent here are usually lost.`,
      });
    else if (check.contract)
      checks.push({
        tone: 'warn',
        text: `This is a contract. Continue only if it accepts ${unit} on ${networkName}, like an exchange deposit or smart wallet.`,
      });
    if (check.ownName)
      checks.push({
        tone: 'info',
        text: `This is your wallet "${check.ownName}". Fund and Collect move funds between your wallets.`,
      });
    else if (!check.sentBefore)
      checks.push({ tone: 'warn', text: 'First time sending to this address.' });
  }
  const from = wallet && addressOf(wallet);
  if (toAddr && from && (sol ? toAddr === from : toAddr.toLowerCase() === from.toLowerCase()))
    checks.push({ tone: 'bad', text: 'This is the wallet you are sending from.' });

  const blocked = checks.some((c) => c.tone === 'bad');
  const ready = !!toAddr && checked && raw !== null && raw > 0n && !tooMuch && !strands && !blocked;
  const passwordNeeded =
    needPassword || usd === null || (settings !== null && usd > settings.confirmAboveUsd);

  const assetOptions = [
    {
      value: NATIVE,
      label: sym,
      sub: `${formatCompact(Number(formatUnits(BigInt(portfolio?.native[walletId] ?? '0'), nd)))} ${sym}`,
    },
    ...(portfolio?.tokens ?? [])
      // Unrequested airdrops stay out until the user marks them as theirs in Wallets.
      .filter((t) => !t.unsolicited && BigInt(t.perWallet[walletId] ?? '0') > 0n)
      .map((t) => ({
        value: t.address,
        label: t.symbol,
        sub: `${formatCompact(Number(formatUnits(BigInt(t.perWallet[walletId] ?? '0'), t.decimals)))} ${t.symbol}`,
      })),
  ];

  const submit = async () => {
    if (!toAddr || raw === null || !parsed) return;
    setError(null);
    setBusy(true);
    const token = asset !== NATIVE ? asset : undefined;
    const pw = passwordNeeded && password ? { password } : {};
    const r = sol
      ? await send({
          type: 'sol.send.execute',
          walletId,
          to: toAddr,
          amount: parsed,
          ...(token ? { mint: token } : {}),
          ...pw,
        })
      : await send({
          type: 'send.execute',
          chainId,
          walletId,
          to: toAddr as Address,
          amount: parsed,
          ...(token ? { token: token as Address } : {}),
          ...pw,
        });
    setBusy(false);
    setPassword('');
    if (r.ok) onSent(r.data.id);
    else if (r.error === 'needs_password') {
      setNeedPassword(true);
      setError('Enter your password to send this.');
    } else setError(errorText(r));
  };

  if (step === 'review' && toAddr && raw !== null) {
    return (
      <div class="stack">
        <h2>Review send</h2>
        <div class="card td-card">
          <div class="kv">
            <span class="muted">Amount</span>
            <span class="kv-v">
              {formatCompact(Number(formatUnits(raw, decimals)))} {unit}
              {usd !== null && <span class="usd">{formatUsd(usd)}</span>}
            </span>
          </div>
          <div class="kv">
            <span class="muted">From</span>
            <span class="kv-v">{wallet?.name}</span>
          </div>
          <div class="kv">
            <span class="muted">Network</span>
            <span class="kv-v">{networkName}</span>
          </div>
          <div class="kv">
            <span class="muted">Network fee</span>
            <span class="kv-v">≈ {feeText}</span>
          </div>
        </div>
        <div class="field">
          <span class="label">To</span>
          <div class="addr-full mono">{grouped(toAddr)}</div>
        </div>
        {checks
          .filter((c) => c.tone === 'warn' || c.tone === 'info')
          .map((c) => (
            <Notice key={c.text} tone={c.tone === 'warn' ? 'warn' : 'info'}>
              {c.text}
            </Notice>
          ))}
        <p class="hint">Sends cannot be undone. Check the address against the source.</p>
        {passwordNeeded && (
          <PasswordField label="Password" value={password} onInput={setPassword} autoFocus />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button
          variant="primary"
          block
          disabled={busy || (passwordNeeded && !password)}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : `Send ${formatCompact(Number(formatUnits(raw, decimals)))} ${unit}`}
        </Button>
        <Button variant="ghost" block onClick={() => setStep('form')}>
          Back
        </Button>
      </div>
    );
  }

  const networks = [
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
  ];

  return (
    <div class="stack">
      <h2>Send</h2>
      <div class="field">
        <span class="label">Network</span>
        <Picker title="Send on" value={chainId} onChange={setChainId} options={networks} />
      </div>
      {usable.length === 0 ? (
        <p class="muted">
          {sol
            ? 'No wallet has a Solana address: keys imported from an EVM wallet have none.'
            : 'No wallet has an EVM address: keys imported from a Solana wallet have none.'}
        </p>
      ) : (
        <>
          <div class="field">
            <span class="label">From</span>
            <Picker
              title="Send from"
              value={walletId}
              onChange={setWalletId}
              options={visible.map((a) => ({
                value: a.id,
                label: `${a.name}${a.primary ? ' ★' : ''}`,
                sub: shortAddress(addressOf(a) ?? ''),
              }))}
            />
          </div>
          <div class="field">
            <span class="label">Asset</span>
            <Picker title="Asset" value={asset} onChange={setAsset} options={assetOptions} />
          </div>
          <TextField
            label="To"
            value={to}
            onInput={setTo}
            placeholder={sol ? 'Solana address' : '0x…'}
            mono
            maxLength={64}
          />
          {checks.length > 0 && (
            <ul class="checks">
              {checks.map((c) => (
                <li key={c.text} class={`chk chk--${c.tone}`}>
                  {c.text}
                </li>
              ))}
            </ul>
          )}
          <div class="field">
            <div class="row">
              <label class="label" for="send-amount">
                Amount ({unit})
              </label>
              <span class="spacer" />
              <button
                type="button"
                class="link"
                disabled={!max}
                onClick={() => max !== null && setAmount(formatUnits(max, decimals))}
              >
                Max
              </button>
            </div>
            <input
              id="send-amount"
              class="input"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onInput={(e) => setAmount(e.currentTarget.value)}
            />
            <p class={tooMuch || strands ? 'error' : 'hint'}>
              {tooMuch
                ? dust
                  ? `Too little to send: emptying a wallet takes at least ${solAmount(minBalance + BigInt(prep?.feeWei ?? '0'))} SOL.`
                  : asset === NATIVE
                    ? `More than the balance after the fee (${formatCompact(Number(formatUnits(max ?? 0n, decimals)))} ${unit}).`
                    : 'More than the balance.'
                : strands
                  ? `Send everything, or leave at least ${solAmount(minBalance)} SOL: Solana closes a wallet below that.`
                  : `Balance ${formatCompact(Number(formatUnits(held, decimals)))} ${unit}${
                      usd !== null ? ` · ≈ ${formatUsd(usd)}` : ''
                    } · fee ≈ ${feeText}`}
            </p>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button
            variant="primary"
            block
            disabled={!ready}
            onClick={() => {
              setError(null);
              setStep('review');
            }}
          >
            Review
          </Button>
        </>
      )}
    </div>
  );
}
