import { useMemo, useState } from 'preact/hooks';
import { encode } from 'uqr';
import { CHAINS } from '../../shared/chains';
import { isSolana } from '../../shared/solana';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { Button, useCopy } from '../../ui/components';
import { Picker } from './Picker';

const QUIET = 3;

/** QR code as one SVG path (no markup strings, no network). */
function Qr({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 });
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
      }),
    );
    return { d: path, size: qr.size + QUIET * 2 };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the address">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0d1220" shape-rendering="crispEdges" />
    </svg>
  );
}

export function Receive({
  accounts,
  chainId,
  initialWalletId,
}: {
  accounts: WalletAccount[];
  chainId: number;
  initialWalletId: string | null;
}) {
  // Each network lists the wallets with an address on it: a key imported for one chain
  // family has none on the other.
  const sol = isSolana(chainId);
  const addressOf = (a: WalletAccount) => (sol ? a.solana : a.address);
  const visible = accounts.filter((a) => addressOf(a) && (!a.hidden || a.id === initialWalletId));
  const fallback = visible.find((a) => a.primary) ?? visible[0];
  const [walletId, setWalletId] = useState(
    visible.some((a) => a.id === initialWalletId) ? (initialWalletId ?? '') : (fallback?.id ?? ''),
  );
  const [copied, copy] = useCopy();
  const wallet = visible.find((a) => a.id === walletId);
  const address = wallet && addressOf(wallet);
  const chainNames = [...CHAINS.values()].map((c) => c.name);

  if (!wallet || !address)
    return (
      <p class="muted">
        {sol
          ? 'No wallet has a Solana address: keys imported from an EVM wallet have none.'
          : 'No wallet has an EVM address: keys imported from a Solana wallet have none.'}
      </p>
    );
  return (
    <div class="stack">
      <h2>Receive</h2>
      <Picker
        title="Receive into"
        value={walletId}
        onChange={setWalletId}
        options={visible.map((a) => ({
          value: a.id,
          label: `${a.name}${a.primary ? ' ★' : ''}`,
          sub: shortAddress(addressOf(a) ?? ''),
        }))}
      />
      <Qr text={address} />
      <div class="addr-full mono">{address}</div>
      <Button variant="primary" block onClick={() => void copy(address)}>
        {copied === address ? 'Copied' : 'Copy address'}
      </Button>
      {sol ? (
        <p class="hint">
          This is a Solana address. Send only SOL and Solana tokens to it, never from an EVM
          network.
        </p>
      ) : (
        <p class="hint">
          The same address works on {chainNames.slice(0, -1).join(', ')} and {chainNames.at(-1)}.
          Make sure the sender uses one of these networks.
        </p>
      )}
    </div>
  );
}
