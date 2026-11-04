import { useEffect, useState } from 'preact/hooks';
import type { WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, PasswordField, TextField, useCopy } from '../../ui/components';

export function WalletDetail({
  account,
  onChanged,
  onRemoved,
}: {
  account: WalletAccount | undefined;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, copy] = useCopy();

  if (!account) return <p class="muted">Wallet not found.</p>;

  const act = async (req: Parameters<typeof send>[0]) => {
    const res = await send(req);
    if (!res.ok) setError(errorText(res));
    else {
      setError(null);
      await onChanged();
    }
    return res.ok;
  };

  return (
    <div class="stack">
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name !== account.name)
            void act({ type: 'wallets.rename', id: account.id, name });
        }}
      >
        <TextField label="Name" value={name} onInput={setName} maxLength={32} />
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || name === account.name}
          style={{ justifySelf: 'start' }}
        >
          Save name
        </Button>
      </form>

      {account.address && (
        <div class="field">
          <span class="label">EVM address</span>
          <div class="row">
            <span class="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
              {account.address}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void copy(account.address ?? '')}>
              {copied === account.address ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {account.kind === 'derived' ? (
            // The path is for matching the wallet in MetaMask / Rabby; most people only
            // need to know where it can be restored from.
            <span class="hint" title={`Derivation path m/44'/60'/0'/0/${account.index ?? 0}`}>
              Restorable from your recovery phrase
            </span>
          ) : (
            <span class="hint hint--warn">
              Imported EVM key: not part of your recovery phrase, and it has no Solana address.
              Export it and keep it safe.
            </span>
          )}
        </div>
      )}

      {account.solana && (
        <div class="field">
          <span class="label">Solana address</span>
          <div class="row">
            <span class="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
              {account.solana}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void copy(account.solana ?? '')}>
              {copied === account.solana ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {account.kind === 'derived' ? (
            <span class="hint" title={`Derivation path m/44'/501'/${account.index ?? 0}'/0'`}>
              Same recovery phrase, as Phantom and Solflare derive it
            </span>
          ) : (
            <span class="hint hint--warn">
              Imported Solana key: not part of your recovery phrase, and it has no EVM address.
              Export it and keep it safe.
            </span>
          )}
        </div>
      )}

      <p class="hint">
        {account.primary
          ? '★ Default wallet: picked first in the trading panel, Bridge and Move funds, on every network it has an address on. It can’t be hidden or removed.'
          : 'The default wallet (★) is picked first in the trading panel, Bridge and Move funds, on every network it has an address on.'}
      </p>
      <div class="row" style={{ flexWrap: 'wrap' }}>
        {!account.primary && (
          <Button
            size="sm"
            onClick={() => void act({ type: 'wallets.setPrimary', id: account.id })}
          >
            Make default
          </Button>
        )}
        {!account.primary && (
          <Button
            size="sm"
            onClick={() =>
              void act({ type: 'wallets.setHidden', id: account.id, hidden: !account.hidden })
            }
          >
            {account.hidden ? 'Unhide' : 'Hide'}
          </Button>
        )}
      </div>

      {account.address && <ExportKey account={account} kind="evm" />}
      {account.solana && <ExportKey account={account} kind="solana" />}

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {!account.primary && (
        <div class="danger-zone">
          <span class="section-title">Remove wallet</span>
          <p class="muted">
            {account.kind === 'imported'
              ? 'The private key is deleted from Nesty. Export it first if you still need it.'
              : 'Removes it from the list. It can be recovered from your recovery phrase.'}
          </p>
          {confirmRemove ? (
            <div class="row">
              <Button size="sm" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (await act({ type: 'wallets.remove', id: account.id })) onRemoved();
                }}
              >
                Confirm remove
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setConfirmRemove(true)}
              style={{ justifySelf: 'start' }}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ExportKey({ account, kind }: { account: WalletAccount; kind: 'evm' | 'solana' }) {
  const what = kind === 'solana' ? 'Solana key' : 'private key';
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Drop the key from memory when leaving the screen.
  useEffect(() => () => setKey(null), []);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} style={{ justifySelf: 'start' }}>
        Export {what}
      </Button>
    );
  }

  if (key) {
    return (
      <div class="stack">
        <Notice tone="danger">
          Anyone with this key controls this wallet
          {kind === 'solana' ? '’s Solana funds' : ''}. Never paste it into a website.
        </Notice>
        <div class="secret">{key}</div>
        {kind === 'solana' && (
          <p class="hint">Phantom and Solflare take it as a private key on import.</p>
        )}
        <p class="hint">
          Copy empties the clipboard after 30 s, including anything else you copy in that time.
        </p>
        <div class="row">
          <Button
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(key);
                setCopied(true);
                await send({ type: 'clipboard.scheduleClear' });
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied — clears in 30 s' : 'Copy'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (setKey(null), setOpen(false), setCopied(false))}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await send({ type: 'wallets.exportKey', id: account.id, password, kind });
        setBusy(false);
        setPassword('');
        if (res.ok) setKey(res.data.privateKey);
        else setError(errorText(res));
      }}
    >
      <PasswordField
        label={`Password to export the ${what} of ${account.name}`}
        value={password}
        onInput={(v) => (setPassword(v), setError(undefined))}
        autoFocus
        error={error}
      />
      <div class="row">
        <Button size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Reveal key'}
        </Button>
      </div>
    </form>
  );
}
