import { useEffect, useRef, useState } from 'preact/hooks';
import { cardPnl, signedPercent, type PnlCard } from '../shared/pnl-card';
import { CARD_H, CARD_W, drawPnlCard, loadCardFonts, type CardLook } from './pnl-card-draw';

/**
 * Sharing a PnL card: the card as it will look, what its amounts are in and whether they
 * show, and three ways out: copy it, save it, or post it on X (copied first, since X takes
 * no picture from a link). The extension shows it in its own window, the website in a
 * dialog; both pass `onClose`.
 */

/** The picture is drawn at twice the card's size, so it stays sharp when opened full size. */
const SCALE = 2;
const LOOK_KEY = 'nesty.pnlShare';

type Choice = Pick<CardLook, 'usd' | 'amounts'>;

/** The last choices, kept in this browser: each page has its own. */
function readChoice(): Choice {
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<Choice> | null;
    return { usd: v?.usd === true, amounts: v?.amounts !== false };
  } catch {
    return { usd: false, amounts: true };
  }
}

function keepChoice(c: Choice): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(c));
  } catch {
    // A browser that keeps nothing: the choice lasts this window.
  }
}

/** "nesty-CAT.png": letters, digits, - and _ only. */
const fileName = (symbol: string) =>
  `nesty-${symbol.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'coin'}.png`;

export function PnlShare({
  card,
  onClose,
  avatar,
  loadSupply,
}: {
  card: PnlCard;
  onClose: () => void;
  avatar?: CardLook['avatar'];
  /** Reads the coin's supply, for the market cap, when the card came without it. */
  loadSupply?: () => Promise<number | null>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  const [choice, setChoice] = useState(readChoice);
  const [supply, setSupply] = useState(card.supply);
  const [flash, setFlash] = useState<'copied' | 'saved' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Counts the page's font loads: a card drawn before its faces were ready is drawn again. */
  const [fontLoads, setFontLoads] = useState(0);
  const pnl = cardPnl(card);
  const pct = signedPercent(pnl.bps);
  const usd = choice.usd && card.unit.usd !== null;

  useEffect(() => {
    first.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    setSupply(card.supply);
    if (card.supply !== null || !loadSupply) return;
    let live = true;
    void loadSupply()
      .then((s) => live && s !== null && s > 0 && setSupply(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [card]);

  useEffect(() => {
    const fonts = document.fonts;
    const loaded = () => setFontLoads((n) => n + 1);
    fonts.addEventListener('loadingdone', loaded);
    return () => fonts.removeEventListener('loadingdone', loaded);
  }, []);

  useEffect(() => {
    let live = true;
    void loadCardFonts().then(() => {
      const ctx = live ? canvas.current?.getContext('2d') : null;
      if (!ctx) return;
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      drawPnlCard(ctx, { ...card, supply }, { usd, amounts: choice.amounts, avatar });
    });
    return () => {
      live = false;
    };
  }, [card, supply, usd, choice.amounts, fontLoads]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const choose = (c: Partial<Choice>) => {
    const next = { ...choice, ...c };
    setChoice(next);
    keepChoice(next);
  };

  const shine = (what: 'copied' | 'saved') => {
    clearTimeout(timer.current);
    setFlash(what);
    timer.current = window.setTimeout(() => setFlash(null), 1_800);
  };

  const png = () =>
    new Promise<Blob>((resolve, reject) => {
      const el = canvas.current;
      if (!el) return reject(new Error('no card'));
      el.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png');
    });

  /** The picture on the clipboard; false when the browser refused it. */
  const copy = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]);
      return true;
    } catch {
      return false;
    }
  };

  const save = async () => {
    try {
      const url = URL.createObjectURL(await png());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(card.symbol);
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNote(null);
      shine('saved');
    } catch {
      setNote('Could not save the picture. Try again.');
    }
  };

  return (
    <section class="pnl-share" aria-labelledby="pnl-share-title">
      <header class="pnl-share-head">
        <h2 id="pnl-share-title">Share PnL</h2>
        <button type="button" class="pnl-share-x" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <canvas
        ref={canvas}
        class="pnl-share-card"
        width={CARD_W * SCALE}
        height={CARD_H * SCALE}
        role="img"
        aria-label={`${pct} on ${card.symbol}`}
      />

      <div class="pnl-share-opts">
        <div class="pnl-share-unit" role="group" aria-label="Amounts in">
          <button
            type="button"
            aria-pressed={!usd}
            disabled={!choice.amounts}
            onClick={() => choose({ usd: false })}
          >
            {card.unit.symbol}
          </button>
          <button
            type="button"
            aria-pressed={usd}
            disabled={!choice.amounts || card.unit.usd === null}
            onClick={() => choose({ usd: true })}
          >
            USD
          </button>
        </div>
        <button
          type="button"
          class="pnl-share-switch"
          role="switch"
          aria-checked={choice.amounts}
          onClick={() => choose({ amounts: !choice.amounts })}
        >
          <span class="pnl-share-track" aria-hidden="true">
            <span />
          </span>
          Show amounts
        </button>
      </div>

      <div class="pnl-share-actions">
        <button
          ref={first}
          type="button"
          class="pnl-share-main"
          onClick={async () => {
            if (await copy()) {
              setNote(null);
              shine('copied');
            } else setNote('Could not copy the picture. Save it instead.');
          }}
        >
          {flash === 'copied' ? 'Copied' : 'Copy image'}
        </button>
        <button type="button" onClick={() => void save()}>
          {flash === 'saved' ? 'Saved' : 'Save image'}
        </button>
        <button
          type="button"
          onClick={async () => {
            const copied = await copy();
            window.open(
              `https://x.com/intent/post?text=${encodeURIComponent(`${pct} on ${card.symbol}`)}`,
              '_blank',
              'noopener,noreferrer',
            );
            setNote(
              copied
                ? 'Image copied. Paste it into your post on X.'
                : 'Could not copy the picture. Save it, then attach it to your post on X.',
            );
          }}
        >
          Post on X
        </button>
      </div>
      {note && (
        <p class="pnl-share-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
