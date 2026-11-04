import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Address } from 'viem';
import { nativeSymbol, networkName } from '../../shared/networks';
import type { SitePendingView } from '../../shared/site-bridge';
import { isSolana } from '../../shared/solana';
import { shortAddress } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, PasswordField } from '../../ui/components';

/**
 * The Nesty website asks for something only the user can allow: to connect, to sign a
 * buy above their confirmation amount, to create a coin, or to bridge (always, when the
 * address paid is none of their wallets). Opened by the background in its own window;
 * closing it turns the request down.
 */
const TITLES: Record<SitePendingView['kind'], string> = {
  connect: 'Connect to Nesty',
  trade: 'Confirm this buy',
  create: 'Create this coin',
  bridge: 'Confirm this bridge',
};

const ACTIONS: Record<SitePendingView['kind'], string> = {
  connect: 'Connect',
  trade: 'Confirm',
  create: 'Create coin',
  bridge: 'Bridge',
};

type BridgeView = Extract<SitePendingView, { kind: 'bridge' }>;

/** What is known of an outside address: warnings to read before it is paid. */
function useRecipientNotes(view: SitePendingView | null | undefined): string[] {
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    if (!view || view.kind !== 'bridge' || view.recipientName !== null) return;
    const chain = view.toChainId;
    const coin = `${nativeSymbol(chain)} on ${networkName(chain)}`;
    void (async () => {
      const out: string[] = [];
      if (isSolana(chain)) {
        const r = await send({ type: 'sol.send.checkRecipient', to: view.recipient });
        if (!r.ok) return;
        if (r.data.kind === 'unused') out.push('Nothing was ever sent to this address.');
        else if (r.data.kind === 'program-account')
          out.push(
            `A program holds this address, like an exchange deposit or a multisig vault. Continue only if it accepts ${coin}.`,
          );
        if (r.data.kind !== 'unused' && !r.data.sentBefore)
          out.push('First time sending to this address.');
      } else {
        const r = await send({
          type: 'send.checkRecipient',
          chainId: chain,
          to: view.recipient as Address,
        });
        if (!r.ok) return;
        if (r.data.contract)
          out.push(
            `This is a contract. Continue only if it accepts ${coin}, like an exchange deposit or smart wallet.`,
          );
        if (!r.data.sentBefore) out.push('First time sending to this address.');
      }
      setNotes(out);
    })();
  }, [view?.id]);
  return notes;
}

function BridgeTo({ view, notes }: { view: BridgeView; notes: string[] }) {
  if (view.recipientName !== null)
    return (
      <span class="muted">
        To your wallet {view.recipientName} ({shortAddress(view.recipient)})
      </span>
    );
  return (
    <>
      <span class="muted">To this address on {networkName(view.toChainId)}</span>
      <span class="address">{view.recipient}</span>
      <Notice tone="warn">
        None of your wallets. Check every character: a bridge cannot be undone.
      </Notice>
      {notes.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
    </>
  );
}

function Approve({ id }: { id: string }) {
  const [view, setView] = useState<SitePendingView | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notes = useRecipientNotes(view);

  useEffect(() => {
    void send({ type: 'site.pending', id }).then((res) => setView(res.ok ? res.data : null));
  }, [id]);

  const decide = async (approve: boolean, e: Event) => {
    if (!e.isTrusted) return;
    const needsPassword = approve && view?.kind === 'bridge' && view.needsPassword;
    setBusy(true);
    const res = await send({
      type: 'site.decide',
      id,
      approve,
      ...(needsPassword ? { password } : {}),
    });
    setBusy(false);
    // A wrong password leaves the request open, to try again.
    if (!res.ok && approve) {
      setError(errorText(res));
      return;
    }
    window.close();
  };

  if (view === undefined) return <p class="muted">Loading…</p>;
  if (view === null)
    return (
      <>
        <h1>Nothing to approve</h1>
        <p class="muted">This request was answered or has expired.</p>
        <Button block onClick={() => window.close()}>
          Close
        </Button>
      </>
    );

  const needsPassword = view.kind === 'bridge' && view.needsPassword;
  return (
    <>
      <h1>
        {view.kind === 'bridge' && view.recipientName === null
          ? 'Bridge to another address'
          : TITLES[view.kind]}
      </h1>
      <div class="who">
        <span class="muted">Requested by</span>
        <span class="origin">{view.origin}</span>
      </div>
      {view.kind === 'connect' ? (
        <ul class="grants">
          <li>See your wallets' addresses.</li>
          <li>
            Ask Nesty to sign its trades and the coins you create, and to bridge. Each is checked
            against your limits first.
          </li>
          <li>
            It never sees your keys. A bridge to an address outside your wallets always asks you
            here first.
          </li>
        </ul>
      ) : (
        <div class="what">
          {view.usd !== null && <span class="usd">${view.usd.toFixed(2)}</span>}
          <span>{view.summary}</span>
          {view.kind === 'bridge' && <span>You receive about {view.receive}</span>}
          <span class="muted">From {view.walletName}</span>
          {view.kind === 'bridge' && <BridgeTo view={view} notes={notes} />}
          {(view.kind === 'trade' || view.kind === 'bridge') && view.why && (
            <span class="why">{view.why}</span>
          )}
        </div>
      )}
      {needsPassword && (
        <PasswordField
          label="Password"
          value={password}
          onInput={(v) => {
            setPassword(v);
            setError(null);
          }}
          error={error ?? undefined}
          autoFocus
        />
      )}
      {!needsPassword && error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        <Button disabled={busy} onClick={(e) => void decide(false, e)}>
          Decline
        </Button>
        <Button
          variant="primary"
          disabled={busy || (needsPassword && !password)}
          onClick={(e) => void decide(true, e)}
        >
          {ACTIONS[view.kind]}
        </Button>
      </div>
    </>
  );
}

const id = new URLSearchParams(location.search).get('id') ?? '';
const root = document.getElementById('app');
if (root) render(<Approve id={id} />, root);
