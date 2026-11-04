import { useState } from 'preact/hooks';
import { passwordNeeds } from '../../shared/password';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField } from '../../ui/components';
import { passwordHint } from '../../ui/password-hint';

/**
 * Seals the wallets under a new password. Opens under its row in Settings and asks for the
 * current password first, like exporting a key; the new one follows the rule for a new wallet.
 */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;
  const valid = current.length > 0 && passwordNeeds(next).length === 0 && confirm === next;

  return (
    <form
      class="pw-change"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        setError(null);
        const res = await send({
          type: 'vault.changePassword',
          password: current,
          newPassword: next,
        });
        setBusy(false);
        if (res.ok) onDone();
        else setError(errorText(res));
      }}
    >
      <PasswordField
        label="Current password"
        value={current}
        onInput={setCurrent}
        autoFocus
        autoComplete="current-password"
      />
      <PasswordField
        label="New password"
        value={next}
        onInput={setNext}
        autoComplete="new-password"
        hint={passwordHint(next)}
      />
      <PasswordField
        label="Confirm new password"
        value={confirm}
        onInput={setConfirm}
        autoComplete="new-password"
        error={mismatch ? 'Passwords do not match.' : undefined}
      />
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <Button
        variant="primary"
        size="sm"
        type="submit"
        disabled={!valid || busy}
        style={{ justifySelf: 'start' }}
      >
        {busy ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  );
}
