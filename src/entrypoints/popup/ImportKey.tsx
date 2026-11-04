import { useState } from 'preact/hooks';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField, TextField } from '../../ui/components';

/** What a pasted key looks like, by format only; the background checks it in full. */
function keyHint(input: string): string {
  const s = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s))
    return 'EVM key: one wallet on every EVM chain. It has no Solana address.';
  if (s.startsWith('[') || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s))
    return 'Solana key: a wallet on Solana only. It has no EVM address.';
  return 'An EVM key (64 hex characters), or a Solana key from Phantom, Solflare or a keypair file.';
}

export function ImportKey({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await send({
          type: 'wallets.importKey',
          privateKey: key,
          ...(name.trim() ? { name } : {}),
        });
        setBusy(false);
        if (res.ok) {
          setKey('');
          onDone();
        } else setError(errorText(res));
      }}
    >
      <h2>Import private key</h2>
      <PasswordField
        label="Private key"
        value={key}
        onInput={(v) => (setKey(v), setError(undefined))}
        hint={keyHint(key)}
        autoFocus
        mono
        error={error}
      />
      <TextField label="Name (optional)" value={name} onInput={setName} maxLength={32} />
      <Button variant="primary" type="submit" block disabled={busy || !key.trim()}>
        Import
      </Button>
    </form>
  );
}
