import { getChain } from '../shared/chains';
import { formatCompact } from '../shared/format';
import { networkLabel } from '../shared/networks';
import {
  amountText,
  cardMcap,
  cardPnl,
  heldFor,
  signedPercent,
  type PnlCard,
} from '../shared/pnl-card';
import { isSolana } from '../shared/solana';
import { COINS, NEST } from './NestMark';

/**
 * The PnL card as a picture: 1200 × 675, drawn on a canvas so it can be copied and saved.
 * Everything on it is drawn here (the mark from its paths, the coin as its initials), so no
 * outside image ever taints the canvas. Its colours are fixed: the picture leaves the page.
 */
export const CARD_W = 1200;
export const CARD_H = 675;

/** How the card is drawn: the choices made in the share window. */
export interface CardLook {
  /** Amounts in dollars, rather than in what the coin was bought with. */
  usd: boolean;
  /** Amounts shown, not only the percentage. */
  amounts: boolean;
  /** Draws the sharer's avatar into a square, where the page has one. */
  avatar?:
    ((ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void) | undefined;
}

const INK = {
  ground: '#08070f',
  text: '#f3f1ff',
  light: '#cdc8ee',
  muted: '#9c96c6',
  line: '#272341',
  lineStrong: '#363060',
  raised: '#1b182f',
  up: '#2ee6a8',
  down: '#ff5c93',
};

/** Each network's dot, as the website colours it. */
const CHAIN_DOT: Record<string, string> = {
  ethereum: '#8a9bff',
  base: '#3d7bff',
  bsc: '#f0b90b',
  arbitrum: '#28a0f0',
  robinhood: '#c6f432',
  elysium: '#97fce4',
};

const UI = "'Barlow', ui-sans-serif, system-ui, sans-serif";
const NUM = "'Barlow Semi Condensed', 'Barlow', ui-sans-serif, system-ui, sans-serif";
const font = (weight: number, size: number, family = NUM) => `${weight} ${size}px ${family}`;

/** The card's faces, loaded before it is drawn: a canvas does not wait for them. */
export async function loadCardFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  await Promise.all(
    [font(700, 40), font(600, 28), font(400, 17, UI)].map((f) =>
      document.fonts.load(f).catch(() => []),
    ),
  );
}

// The layout, in the card's own pixels.
const PAD_X = 60;
const HEAD_Y = 52;
const HEAD_H = 38;
const FOOT_LINE = 540;
const FOOT_BOTTOM = CARD_H - 48;
const MID_Y = (HEAD_Y + HEAD_H + FOOT_LINE) / 2;
const CHART_W = 380;
const CHART_GAP = 36;
const LEFT_W = CARD_W - 2 * PAD_X - CHART_W - CHART_GAP;

/** The baseline that centres the current font's line box on `cy`, as CSS centres a line. */
function baselineFor(ctx: CanvasRenderingContext2D, cy: number): number {
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent;
  return cy + (ascent - descent) / 2;
}

/** Text cut to a width, with an ellipsis; by characters, so no emoji is split. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > max) chars.pop();
  return `${chars.join('')}…`;
}

/** Two letters for the coin's round mark: its first two letters or digits. */
const initials = (symbol: string) =>
  Array.from(symbol.replace(/[^\p{L}\p{N}]/gu, ''))
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 44, size / 44);
  ctx.translate(-10, -10);
  ctx.fillStyle = INK.up;
  ctx.fill(new Path2D(COINS));
  ctx.fillStyle = INK.text;
  ctx.fill(new Path2D(NEST));
  ctx.restore();
}

function chainPill(ctx: CanvasRenderingContext2D, chainId: number, right: number, top: number) {
  const label = networkLabel(chainId);
  ctx.font = font(600, 19);
  const width = 16 + 10 + 9 + ctx.measureText(label).width + 16;
  const left = right - width;
  const cy = top + HEAD_H / 2;
  ctx.beginPath();
  ctx.roundRect(left + 0.5, top + 0.5, width - 1, HEAD_H - 1, HEAD_H / 2);
  ctx.strokeStyle = INK.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  const dx = left + 16 + 5;
  if (isSolana(chainId)) {
    const g = ctx.createLinearGradient(dx - 5, cy - 5, dx + 5, cy + 5);
    g.addColorStop(0, '#9945ff');
    g.addColorStop(1, '#14f195');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = CHAIN_DOT[getChain(chainId)?.dexscreenerSlug ?? ''] ?? INK.muted;
  }
  ctx.beginPath();
  ctx.arc(dx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK.light;
  ctx.textAlign = 'left';
  ctx.fillText(label, left + 16 + 10 + 9, baselineFor(ctx, cy));
}

/**
 * The position's trades as a line: from the buy that opened it to the sell or today, on a
 * log scale so a coin that ran a hundred times still reads. The dashed level is the
 * average price paid, where profit starts.
 */
function drawTrail(ctx: CanvasRenderingContext2D, card: PnlCard, tone: string): void {
  // Drawn on a 420 × 260 grid, scaled into the card.
  const W = 420;
  const H = 260;
  const k = CHART_W / W;
  ctx.save();
  ctx.translate(CARD_W - PAD_X - CHART_W, MID_Y - (H * k) / 2);
  ctx.scale(k, k);
  const prices = card.points.length > 1 ? card.points : [card.points[0] ?? 1, card.points[0] ?? 1];
  const logs = prices.map((p) => Math.log(p));
  const entry =
    card.value > 0 ? (prices[prices.length - 1] as number) * (card.cost / card.value) : null;
  const all = entry === null ? logs : [...logs, Math.log(entry)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const top = 36;
  const span = H - 2 * top;
  const yOf = (v: number) => (hi - lo < 1e-9 ? H / 2 : top + ((hi - v) / (hi - lo)) * span);
  const left = 36;
  const right = W - 36;
  const pts = logs.map((v, i) => ({
    x: left + ((right - left) * i) / (logs.length - 1),
    y: yOf(v),
  }));

  if (entry !== null) {
    const y = yOf(Math.log(entry));
    ctx.beginPath();
    ctx.setLineDash([6, 6]);
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.strokeStyle = INK.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = tone;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const first = pts[0] as { x: number; y: number };
  const last = pts[pts.length - 1] as { x: number; y: number };
  ctx.beginPath();
  ctx.arc(first.x, first.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = INK.ground;
  ctx.fill();
  ctx.strokeStyle = tone;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 14, 0, Math.PI * 2);
  ctx.fillStyle = tone;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
  ctx.fill();

  // Each label on the side the line leaves free.
  ctx.font = font(600, 17);
  ctx.fillStyle = INK.muted;
  ctx.textAlign = 'center';
  const next = pts[1] as { x: number; y: number };
  const before = pts[pts.length - 2] as { x: number; y: number };
  ctx.fillText('Buy', first.x, next.y < first.y ? first.y + 32 : first.y - 18);
  ctx.fillText(
    card.kind === 'sold' ? 'Sell' : 'Now',
    last.x,
    before.y > last.y ? last.y - 22 : last.y + 34,
  );
  ctx.restore();
}

/** Draws the card on a context whose units are the card's pixels (scale it for a sharp copy). */
export function drawPnlCard(ctx: CanvasRenderingContext2D, card: PnlCard, look: CardLook): void {
  const pnl = cardPnl(card);
  const tone = pnl.units < 0 ? INK.down : INK.up;
  const usdPrice = card.unit.usd;
  const inUsd = look.usd && usdPrice !== null;
  const shown = (v: number) =>
    inUsd ? amountText(v * (usdPrice as number), null) : amountText(v, card.unit.symbol);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '0px';
  ctx.fillStyle = INK.ground;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // The mark and name; the network on the right.
  drawMark(ctx, PAD_X, HEAD_Y, HEAD_H);
  ctx.font = font(700, 30);
  ctx.fillStyle = INK.text;
  ctx.fillText('Nesty', PAD_X + HEAD_H + 12, baselineFor(ctx, HEAD_Y + HEAD_H / 2));
  chainPill(ctx, card.chainId, CARD_W - PAD_X, HEAD_Y);

  // The coin, the percentage, and what it came to.
  const pct = signedPercent(pnl.bps);
  let size = 172;
  ctx.font = font(700, size);
  ctx.letterSpacing = `${-0.015 * size}px`;
  const wide = ctx.measureText(pct).width;
  if (wide > LEFT_W) {
    size = Math.floor((size * LEFT_W) / wide);
    ctx.font = font(700, size);
    ctx.letterSpacing = `${-0.015 * size}px`;
  }
  ctx.letterSpacing = '0px';
  const pctLine = size * 0.88;
  const amountsLine = 48;
  const height = 52 + 20 + pctLine + 16 + (look.amounts ? amountsLine : 0);
  const top = MID_Y - height / 2;

  ctx.beginPath();
  ctx.arc(PAD_X + 26, top + 26, 25.5, 0, Math.PI * 2);
  ctx.fillStyle = INK.raised;
  ctx.fill();
  ctx.strokeStyle = INK.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = font(700, 19);
  ctx.fillStyle = INK.light;
  ctx.textAlign = 'center';
  ctx.fillText(initials(card.symbol), PAD_X + 26, baselineFor(ctx, top + 26));
  ctx.textAlign = 'left';
  ctx.font = font(700, 40);
  ctx.fillStyle = INK.text;
  const symbolX = PAD_X + 52 + 14;
  ctx.fillText(
    fitText(ctx, card.symbol, PAD_X + LEFT_W - symbolX),
    symbolX,
    baselineFor(ctx, top + 26),
  );

  ctx.font = font(700, size);
  ctx.letterSpacing = `${-0.015 * size}px`;
  ctx.fillStyle = tone;
  ctx.fillText(pct, PAD_X, baselineFor(ctx, top + 72 + pctLine / 2));
  ctx.letterSpacing = '0px';

  if (look.amounts) {
    const lead = inUsd
      ? amountText(pnl.usd as number, null, true)
      : amountText(pnl.units, card.unit.symbol, true);
    const second = inUsd
      ? amountText(pnl.units, card.unit.symbol, true)
      : pnl.usd === null
        ? null
        : amountText(pnl.usd, null, true);
    ctx.font = font(700, 40);
    const base = baselineFor(ctx, top + 72 + pctLine + 16 + amountsLine / 2);
    ctx.fillStyle = INK.text;
    ctx.fillText(lead, PAD_X, base);
    if (second) {
      const x = PAD_X + ctx.measureText(lead).width + 16;
      ctx.font = font(600, 28);
      ctx.fillStyle = INK.muted;
      ctx.fillText(fitText(ctx, second, PAD_X + LEFT_W - x), x, base);
    }
  }

  drawTrail(ctx, card, tone);

  // The footing: what was paid and fetched, the market cap, how long it was held.
  ctx.beginPath();
  ctx.moveTo(PAD_X, FOOT_LINE + 0.5);
  ctx.lineTo(CARD_W - PAD_X, FOOT_LINE + 0.5);
  ctx.strokeStyle = INK.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  const mcap = cardMcap(card);
  const stats: { label: string; value: string }[] = [
    ...(look.amounts
      ? [
          { label: 'Bought', value: shown(card.cost) },
          { label: card.kind === 'sold' ? 'Sold' : 'Worth now', value: shown(card.value) },
        ]
      : []),
    ...(mcap
      ? [
          {
            label: 'Market cap',
            value: `$${formatCompact(mcap.from)} → $${formatCompact(mcap.to)}`,
          },
        ]
      : []),
    ...(card.start !== null
      ? [
          {
            label: card.kind === 'sold' ? 'Held' : 'Holding',
            value: heldFor(card.end - card.start),
          },
        ]
      : []),
  ];
  let x = PAD_X;
  for (const s of stats) {
    ctx.font = font(400, 17, UI);
    ctx.fillStyle = INK.muted;
    ctx.fillText(s.label, x, FOOT_BOTTOM - 44);
    const lw = ctx.measureText(s.label).width;
    ctx.font = font(700, 28);
    ctx.fillStyle = INK.text;
    ctx.fillText(s.value, x, FOOT_BOTTOM - 8);
    x += Math.max(lw, ctx.measureText(s.value).width) + 48;
  }
  if (look.avatar) look.avatar(ctx, CARD_W - PAD_X - 44, FOOT_BOTTOM - 44, 44);
  ctx.restore();
}
