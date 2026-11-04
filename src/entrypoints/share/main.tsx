import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import { browser } from 'wxt/browser';
import { SHARE_KEY, readCard, type PnlCard } from '../../shared/pnl-card';
import { send } from '../../ui/api';
import { PnlShare } from '../../ui/PnlShare';

/**
 * The PnL card window, opened by the background from the panel or the popup: it shows the
 * card the background keeps in storage.session, and the next one in place when another
 * PnL figure is clicked while it is open.
 */
function Share() {
  const [card, setCard] = useState<PnlCard | null | undefined>(undefined);
  useEffect(() => {
    void browser.storage.session
      .get(SHARE_KEY)
      .then((r) => setCard(readCard(r[SHARE_KEY])))
      .catch(() => setCard(null));
    const changed = (changes: Record<string, { newValue?: unknown }>) => {
      if (SHARE_KEY in changes) setCard(readCard(changes[SHARE_KEY]?.newValue));
    };
    browser.storage.session.onChanged.addListener(changed);
    return () => browser.storage.session.onChanged.removeListener(changed);
  }, []);

  if (card === undefined) return null;
  if (card === null) return <p class="muted">Nothing to share. Click a PnL figure in Nesty.</p>;
  return (
    <PnlShare
      key={`${card.chainId}:${card.token}:${card.kind}:${card.end}`}
      card={card}
      onClose={() => window.close()}
      loadSupply={async () => {
        const r = await send({ type: 'token.supply', chainId: card.chainId, token: card.token });
        return r.ok && r.data !== null ? Number(formatUnits(BigInt(r.data), card.decimals)) : null;
      }}
    />
  );
}

const root = document.getElementById('app');
if (root) render(<Share />, root);
