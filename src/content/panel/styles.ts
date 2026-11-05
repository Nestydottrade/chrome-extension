import { PANEL_FONT, PANEL_FONT_NUM } from './fonts';
import exitPlanCss from '../../ui/exit-plan.css?inline';
import { PANEL_GAP, PANEL_WIDTH, TOASTS_WIDTH } from './layout';

// Injected as a <style> text node inside the closed shadow root, so page CSS cannot leak in.
//
// Look: "flight deck". A dark slate base (it sits on dark terminals, so it stays dark),
// Nesty's green for focus and the moment a trade fires, mint for buys and rose for
// sells. Text is Barlow; numbers, keys and headings Barlow Semi Condensed (both
// registered by fonts.ts), falling back to Bahnschrift / system UI.
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.k, .toasts {
  --bg: #0f141d; --surface: #161d2a; --surface-2: #1e2737; --border: #1e2737; --border-strong: #2a3447;
  --text: #eaf0fa; --light: #b9c4d8; --muted: #93a0b8; --faint: #6f7c95;
  --flash: #2ee6a8; --flash-hot: #6af0c3; --buy: #3ee0a4; --sell: #ff7d94; --warn: #ffb547; --focus: #2ee6a8;
  --buy-bg: #11231d; --buy-line: #1f4a3a; --buy-key: #1b3a2f;
  --sell-bg: #24141b; --sell-line: #4a2430; --sell-key: #3a1d27;
  --num: "${PANEL_FONT_NUM}", "Bahnschrift", "DIN Alternate", ui-sans-serif, system-ui, sans-serif;
  --ui: "${PANEL_FONT}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --ease-out: cubic-bezier(.22, 1, .36, 1); --ease-spring: cubic-bezier(.34, 1.56, .64, 1);
}
.k {
  position: fixed; z-index: 2147483647; width: ${PANEL_WIDTH}px;
  /* Never taller than the window: on short windows the rest scrolls, the header stays. */
  max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain;
  color: var(--text); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 18px;
  box-shadow: 0 1px 0 rgb(255 255 255 / .04) inset, 0 20px 56px rgb(2 6 18 / .72);
  font: 500 13px/1.4 var(--ui);
  font-variant-numeric: tabular-nums;
  user-select: none;
  animation: panel-in .32s var(--ease-out);
  transform-origin: top right;
}
@keyframes panel-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
.k button, .k input { font: inherit; color: inherit; }
/* A slim thumb on no track, inset from the rounded edge; no arrow buttons. */
.k::-webkit-scrollbar { width: 10px; }
.k::-webkit-scrollbar-track { background: transparent; margin: 18px 0; }
.k::-webkit-scrollbar-thumb { background: var(--border-strong); border: 3px solid transparent; border-radius: 999px; background-clip: padding-box; }
.k::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.k::-webkit-scrollbar-button { display: none; }
.k :focus-visible { outline: 2px solid var(--flash); outline-offset: 1px; }
.k h2 { margin: 0; }

/* header */
.head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 12px; border-bottom: 1px solid var(--border); cursor: grab; position: sticky; top: 0; z-index: 2; background: var(--bg); border-radius: 18px 18px 0 0; }
.head:active { cursor: grabbing; }
.mark { display: inline-grid; color: var(--text); flex: none; transition: transform .3s var(--ease-spring); }
.head:hover .mark { transform: rotate(-8deg) scale(1.06); }
.id { display: grid; gap: 2px; min-width: 0; flex: 1; }
.id-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand { display: inline-flex; align-items: center; gap: 5px; color: var(--text); font: 700 16px/1 var(--num); letter-spacing: .01em; }
.nest-mark { flex: none; }
.sym { font: 700 18px/1.05 var(--num); letter-spacing: .01em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain { flex: none; font: 600 11px/1.3 var(--ui); padding: 2px 7px; border-radius: 6px; background: var(--surface-2); color: var(--light); }
.sp { flex: 1; }
.addr-row { display: inline-flex; align-items: center; gap: 5px; justify-self: start; }
.addr { font: 500 12px/1.2 var(--ui); color: var(--muted); text-decoration: none; }
.copy { display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 11px; transition: color .12s ease; }
.copy:hover { color: var(--flash); }
.addr:hover { color: var(--flash); text-decoration: underline; }
.ib { flex: none; display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; border: 0; background: var(--surface); color: var(--muted); cursor: pointer; transition: color .12s ease, background-color .12s ease, transform .12s var(--ease-out); }
.ib:hover { color: var(--text); background: var(--surface-2); }
.ib:active { transform: scale(.9); }

.body { padding: 14px; display: grid; gap: 14px; animation: rise .26s var(--ease-out); }
@keyframes rise { from { opacity: 0; transform: translateY(5px); } }
.row { display: flex; align-items: center; gap: 6px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }

/* position card */
.pos { position: relative; display: grid; gap: 10px; padding: 14px; border-radius: 14px; background: var(--surface); }
.pos-top { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 500; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--bg); cursor: pointer; font-size: 12px; font-weight: 600; transition: border-color .12s ease, transform .12s var(--ease-out); }
.chip:hover, .chip[aria-expanded="true"] { border-color: var(--flash); }
.chip:active { transform: scale(.95); }
.chip svg { transition: transform .22s var(--ease-out); }
.chip[aria-expanded="true"] svg { transform: rotate(180deg); }
.chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--flash); }
.picker { position: absolute; z-index: 3; top: 46px; right: 10px; left: 10px; display: grid; gap: 4px; max-height: 280px; overflow: auto; padding: 4px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--border-strong); box-shadow: 0 14px 34px rgb(2 6 18 / .65); transform-origin: top right; animation: pop .2s var(--ease-out); }
@keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.96); } }
.pk-head { display: flex; align-items: center; gap: 4px; padding: 2px 4px 6px; border-bottom: 1px solid var(--border-strong); margin-bottom: 2px; font-size: 11px; }
.pk-q { height: 24px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg); color: var(--light); font-size: 11.5px; font-weight: 600; cursor: pointer; transition: border-color .12s ease, color .12s ease; }
.pk-q:hover:not(:disabled) { border-color: var(--flash); color: var(--text); }
.pk-q:disabled { opacity: .45; cursor: not-allowed; }
/* Two wallets a row: name, what it holds of this token, its native balance. */
.wgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.wcard { position: relative; min-width: 0; border: 1px solid transparent; border-radius: 9px; background: var(--bg); transition: border-color .12s ease, background-color .12s ease; }
.wcard:hover { border-color: var(--border-strong); }
.wcard.on { border-color: rgb(46 230 168 / .45); background: #121f1b; }
/* A tick that shows selection; the whole card is the target. */
.wtick { position: absolute; top: 8px; right: 8px; width: 14px; height: 14px; border: 1px solid var(--border-strong); border-radius: 4px; }
.wcard.on .wtick { border-color: var(--flash); background: var(--flash); }
.wcard.on .wtick::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid #04150d; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.wsolo { width: 100%; min-width: 0; display: grid; gap: 3px; padding: 7px 28px 7px 9px; border: 0; background: none; text-align: left; cursor: pointer; }
.wname { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.whold { color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcard.holds .whold { color: var(--buy); font-weight: 600; }
.wsolo small { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Loading placeholders. */
.skel { display: block; height: 10px; border-radius: 6px; background: linear-gradient(90deg, var(--surface-2) 0%, var(--border-strong) 50%, var(--surface-2) 100%); background-size: 200% 100%; animation: shimmer 1.1s linear infinite; }
.skel.w40 { width: 40%; } .skel.w50 { width: 50%; } .skel.w70 { width: 70%; } .skel.w80 { width: 80%; }
.skel.big { height: 30px; border-radius: 8px; }
.skel.box { flex: 1; height: 32px; border-radius: 10px; }
.skel.key { height: 78px; border-radius: 12px; }
.tb .sub .skel { height: 9px; margin: 3px 0 2px; }
.wsolo .skel { height: 9px; margin: 2px 0; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
/* Saved groups: a row of chips above the position, scrolling sideways when long. */
.gchips { display: flex; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.gchips::-webkit-scrollbar { display: none; }
.gchips button { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--bg); color: var(--light); font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color .12s ease, color .12s ease, background-color .12s ease, transform .1s var(--ease-out); }
.gchips button small { color: var(--faint); font: 600 11px/1 var(--num); }
.gchips button:hover:not(:disabled) { color: var(--text); border-color: var(--muted); }
.gchips button:active:not(:disabled) { transform: scale(.95); }
.gchips button:disabled { opacity: .4; cursor: not-allowed; }
.gchips button[aria-pressed="true"] { border-color: var(--flash); background: #10251f; color: var(--flash); }
.gchips button[aria-pressed="true"] small { color: var(--flash); }
.gcustom { flex: none; align-self: center; padding: 0 4px; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.pk-foot { display: flex; align-items: center; gap: 6px; padding: 6px 4px 2px; border-top: 1px solid var(--border-strong); margin-top: 2px; font-size: 11px; min-height: 30px; }
.pk-save { border: 0; padding: 0; background: none; color: var(--flash); font-size: 12px; font-weight: 700; cursor: pointer; }
.pk-name { display: flex; gap: 4px; width: 100%; }
.pk-name input { flex: 1; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg); font-size: 12px; outline: none; }
.pk-name input:focus { border-color: var(--flash); }
.pk-q.on { border-color: var(--flash); color: var(--flash); }
.wchips { display: flex; gap: 6px; min-width: 0; }
.wchips button { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--bg); color: var(--light); font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color .12s ease, color .12s ease, background-color .12s ease, transform .1s var(--ease-out); }
.wchips button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wchips button:hover { color: var(--text); border-color: var(--muted); }
.wchips button:active { transform: scale(.95); }
.wchips button[aria-pressed="true"] { border-color: var(--flash); background: #10251f; color: var(--flash); }
.hold-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--buy); }
.pos-main { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; min-width: 0; }
.pos-amt { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pos-amt .big { font: 600 36px/1 var(--num); white-space: nowrap; }
.pos-amt .muted { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pnl { display: grid; justify-items: end; gap: 2px; flex: none; margin: -4px -7px; padding: 4px 7px; border: 0; border-radius: 7px; background: none; font: inherit; text-align: right; cursor: pointer; animation: rise .3s var(--ease-out); transition: background-color .12s ease, box-shadow .12s ease; }
.pnl.up:hover { background: var(--buy-bg); box-shadow: inset 0 0 0 1px var(--buy-line); }
.pnl.down:hover { background: var(--sell-bg); box-shadow: inset 0 0 0 1px var(--sell-line); }
.pnl:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.pnl-usd { font: 600 20px/1 var(--num); }
.pnl-pct { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 600; }
.pnl-sub { display: inline-flex; align-items: center; gap: 6px; }
/* Share, so the PnL card is found. */
.share-tag { display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--light); font: 600 11px/1 var(--num); transition: border-color .12s ease, color .12s ease; }
.pnl:hover .share-tag, .pnl:focus-visible .share-tag { border-color: var(--light); color: var(--text); }
.pnl.up { color: var(--buy); }
.pnl.down { color: var(--sell); }
.pos-foot { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
.pos-foot span:last-child { white-space: nowrap; }

/* buy and sell */
.side { display: grid; gap: 8px; }
.side-head { display: flex; align-items: center; gap: 6px; }
.side-head .edit { margin-left: auto; }
.side-head .init { height: 24px; padding: 0 8px; border: 1px solid var(--sell-line); border-radius: 7px; background: var(--sell-bg); color: var(--sell); font: 600 12px/1 var(--ui); white-space: nowrap; cursor: pointer; transition: border-color .12s ease; }
.side-head .init:hover:not(:disabled) { border-color: var(--sell); }
.side-head .init:disabled { opacity: .4; cursor: not-allowed; }
.mw { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface); }
.mw button { height: 22px; padding: 0 7px; border: 0; border-radius: 6px; background: none; color: var(--muted); font: 600 11.5px/1 var(--ui); cursor: pointer; white-space: nowrap; transition: color .12s ease, background-color .15s ease; }
.mw button:hover { color: var(--text); }
.mw button[aria-pressed="true"] { background: var(--border-strong); color: #fff; font-weight: 700; }
.side-head h2 { font: 700 15px/1 var(--num); letter-spacing: .01em; }
.side-head h2.buy { color: var(--buy); }
.side-head h2.sell { color: var(--sell); }
.edit { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 0; border-radius: 7px; background: none; color: var(--muted); font-size: 12px; cursor: pointer; transition: color .12s ease, background-color .12s ease; }
.edit:hover { color: var(--text); background: var(--surface); }
.edit[aria-pressed="true"] { color: var(--flash); background: var(--surface); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.sells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }

/* trade keys: the panel's one loud element */
.tb {
  position: relative; overflow: hidden; display: grid; gap: 6px; text-align: left; min-width: 0;
  padding: 11px 12px 10px; border-radius: 12px; border: 1px solid; cursor: pointer;
  transition: transform .1s var(--ease-out), border-color .12s ease, background-color .12s ease;
}
.tb:active:not(:disabled) { transform: scale(.96); }
.tb:disabled { opacity: .4; cursor: not-allowed; }
.tb-top { display: flex; justify-content: space-between; align-items: center; gap: 4px; min-width: 0; }
.tb .main { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; font: 600 21px/1 var(--num); color: var(--text); white-space: nowrap; }
.tb .main small { font: 600 11px/1 var(--ui); color: var(--muted); }
.tb .sub { font-size: 12px; color: var(--light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb kbd { flex: none; min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 3px; border-radius: 5px; font: 700 11px/1 var(--num); }
.tb.buy { background: var(--buy-bg); border-color: var(--buy-line); }
.tb.buy kbd { background: var(--buy-key); color: #8fe9c5; }
.tb.buy:hover:not(:disabled) { border-color: var(--buy); background: #132a22; }
.tb.sell { gap: 4px; padding: 9px 9px 8px; background: var(--sell-bg); border-color: var(--sell-line); }
.tb.sell .main { font-size: 18px; }
.tb.sell .sub { font-size: 11px; }
.tb.sell kbd { min-width: 16px; height: 16px; font-size: 10px; border-radius: 4px; background: var(--sell-key); color: #ffb3c1; }
.tb.sell:hover:not(:disabled) { border-color: var(--sell); background: #2b1720; }
.meter-row { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 600; }
.meter { flex: 1; height: 3px; border-radius: 2px; background: var(--buy-key); overflow: hidden; }
.meter > span { display: block; height: 100%; border-radius: 2px; background: currentColor; transition: width .4s var(--ease-out); }
.meter.faint { color: var(--faint); }
/* A key fires: a ring pulses out from it. */
.tb::before { content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none; opacity: 0; box-shadow: 0 0 0 0 currentColor; }
.tb.buy::before { color: rgb(62 224 164 / .45); }
.tb.sell::before { color: rgb(255 125 148 / .45); }
.tb:active:not(:disabled)::before { animation: fire .45s var(--ease-out); }
@keyframes fire { 0% { opacity: 1; box-shadow: 0 0 0 0 currentColor; } 100% { opacity: 0; box-shadow: 0 0 0 8px currentColor; } }
/* Sending: a flash runs across the key until the background answers. */
.tb[aria-busy="true"] { cursor: progress; border-color: var(--flash); }
.tb[aria-busy="true"] .sub { color: var(--flash-hot); }
.tb[aria-busy="true"]::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgb(46 230 168 / .26) 50%, transparent 70%);
  animation: strike .7s linear infinite;
}
@keyframes strike { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.imp-ok { color: var(--buy); } .imp-warn { color: var(--warn); } .imp-bad { color: var(--sell); }
.meter-row > span:last-child.faint, .imp-txt.imp-ok { color: var(--muted); }

/* inputs and buttons */
.custom { display: flex; gap: 8px; }
.amt { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface); transition: border-color .12s ease; }
.amt:focus-within { border-color: var(--flash); }
.amt input { flex: 1; min-width: 0; border: 0; background: none; padding: 0; font: 500 14px/1 var(--ui); user-select: text; }
.amt input:focus { outline: none; }
.amt input::placeholder { color: var(--faint); font: 500 14px/1 var(--ui); }
.amt .unit { color: var(--muted); font-size: 12px; font-weight: 600; }
.btn { height: 34px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer; font-weight: 700; transition: transform .1s var(--ease-out), border-color .12s ease, filter .12s ease; }
.btn:hover:not(:disabled) { border-color: var(--muted); }
.btn:active:not(:disabled) { transform: scale(.96); }
.btn.big { height: 44px; padding: 0 22px; border-radius: 12px; font: 700 16px/1 var(--num); }
.btn.sm { height: 24px; padding: 0 9px; border-radius: 7px; font-size: 11px; }
.btn.buy { background: var(--buy); border-color: var(--buy); color: #062016; }
.btn.buy.big { border: 0; }
.btn.sell { background: var(--sell); border-color: var(--sell); color: #2a0711; }
.btn.accent { background: var(--flash); border-color: var(--flash); color: #04150d; }
.btn.buy:hover:not(:disabled), .btn.sell:hover:not(:disabled), .btn.accent:hover:not(:disabled) { filter: brightness(1.08); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; background: var(--surface); padding: 3px 8px; cursor: pointer; color: var(--muted); }
.seg button[aria-pressed="true"] { background: var(--flash); color: #04150d; font-weight: 700; }

.summary { padding: 8px 11px; border-radius: 10px; background: var(--surface); border: 1px dashed var(--border-strong); font-family: var(--num); animation: rise .22s var(--ease-out); }
.card { border: 1px solid var(--border-strong); border-radius: 12px; padding: 11px 12px; background: var(--surface); display: grid; gap: 6px; animation: rise .24s var(--ease-out); }
.card.danger { border-color: var(--sell-line); background: var(--sell-bg); }
.card.warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 7%, var(--surface)); }
.act { display: flex; gap: 6px; align-items: baseline; }
.act .ok { color: var(--buy); } .act .no { color: var(--sell); }

/* footer status */
.status { display: flex; gap: 2px 10px; align-items: center; font-size: 12px; color: var(--light); border-top: 1px solid var(--border); background: #0c1119; padding: 11px 14px; border-radius: 0 0 18px 18px; }
.status > span { white-space: nowrap; flex: none; }
/* One line: the venue name gives way first (full name in its tooltip). */
.status > .venue { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.status > .sp { flex: 1; margin-left: -10px; }
.status > .venue { margin-left: -4px; }
.route { display: inline-grid; color: var(--light); }
.route.on svg { animation: live 2.4s ease-in-out infinite; }
@keyframes live { 50% { opacity: .55; } }
.ready { display: inline-flex; align-items: center; gap: 5px; color: var(--flash); font-weight: 600; }

.mini { display: flex; align-items: center; gap: 6px; padding: 9px 10px; animation: rise .22s var(--ease-out); }
.mini .tb { flex: 1; padding: 7px 9px; gap: 0; }
.mini .tb .main { font-size: 14px; }

/* toasts */
.t-stuck { display: flex; align-items: center; gap: 8px; color: var(--warn); font-size: 12px; line-height: 1.35; }
.t-stuck .btn { flex: none; height: 26px; padding: 0 10px; font-size: 12px; }
/* Never taller than the window: a burst of trades scrolls inside the stack instead of leaving the screen. */
.toasts { position: fixed; z-index: 2147483647; right: ${PANEL_GAP}px; bottom: ${PANEL_GAP}px; display: grid; gap: 12px; width: ${TOASTS_WIDTH}px; max-height: calc(100vh - ${2 * PANEL_GAP}px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
.toasts::-webkit-scrollbar { display: none; }
.toast {
  position: relative; overflow: hidden; display: grid; gap: 12px;
  padding: 14px; border-radius: 16px;
  background: #131a26; border: 1px solid var(--border-strong);
  color: var(--text); font: 500 13px/1.4 var(--ui); font-variant-numeric: tabular-nums;
  box-shadow: 0 14px 36px rgb(2 6 18 / .65); user-select: none;
  animation: toast-in .34s var(--ease-spring);
}
.toast.ok { background: #10201b; border-color: var(--buy-line); }
.toast.warn { background: #1f1a10; border-color: #4a3a1a; }
.toast.bad { gap: 10px; background: #1f1218; border-color: var(--sell-line); }
@keyframes toast-in { from { opacity: 0; transform: translateX(14px) scale(.97); } }
.t-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.t-head.top { align-items: flex-start; }
.t-head strong { flex: 1; min-width: 0; font: 700 16px/1.2 var(--num); }
.toast.bad .t-head strong { color: var(--sell); }
.t-meta { flex: none; color: var(--muted); font-size: 12px; white-space: nowrap; }
.t-x { width: 28px; height: 28px; margin: -4px -4px 0 0; background: none; }
.t-x:hover { background: rgb(255 255 255 / .06); }
.t-pulse { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--flash); box-shadow: 0 0 0 4px rgb(46 230 168 / .16); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 6px rgb(46 230 168 / .05); } }
.t-legs { display: grid; gap: 10px; }
.t-leg { display: grid; gap: 6px; }
.t-leg-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.t-who { font-weight: 600; white-space: nowrap; }
.t-sent { color: var(--flash); font-weight: 600; text-align: right; }
.t-quiet { color: var(--muted); font-weight: 500; }
.t-bad { color: var(--sell); font-weight: 600; }
.t-leg .spd { height: 6px; }
.t-err { min-width: 0; color: #e6c9d0; font-size: 12px; overflow-wrap: anywhere; }
.t-msg { margin: 0; color: #e6c9d0; line-height: 1.45; overflow-wrap: anywhere; }
.t-acts { display: flex; gap: 8px; }
.t-acts .btn { flex: 1; height: 36px; border-radius: 10px; background: #1a2232; font-weight: 600; }
.t-acts .btn.t-ghost { background: none; color: var(--light); }
.toast.bad .t-acts .btn.t-ghost { border-color: var(--sell-line); color: #e6c9d0; }
.t-acts .btn.t-retry { border: 0; background: var(--sell); color: #2a0a12; font-weight: 700; }
.t-sum { display: grid; gap: 3px; flex: 1; min-width: 0; }
.t-done { color: var(--buy); font-size: 12px; font-weight: 700; }
.toast.warn .t-done { color: var(--warn); }
.t-big { font: 600 24px/1.05 var(--num); overflow-wrap: anywhere; }
.t-line { color: var(--muted); font-size: 12px; }
.t-speed { display: grid; gap: 8px; padding: 12px; border-radius: 12px; background: #0c1915; }
.toast.warn .t-speed { background: #15120a; }
.t-speed-top { display: flex; justify-content: space-between; align-items: baseline; }
.t-speed-top span { color: var(--light); font-size: 12px; font-weight: 600; }
.t-speed-top b { color: var(--flash); font: 700 20px/1 var(--num); }
.spd { display: flex; gap: 2px; height: 8px; }
.spd i { min-width: 3px; border-radius: 3px; }
.spd-legend { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; color: var(--muted); font-size: 11px; }
.spd-legend > span { display: grid; }
.spd-legend b { color: var(--text); font-weight: 600; }
.spd-legend i { display: none; }
.t-link { justify-self: start; color: var(--flash); font-size: 12px; font-weight: 600; text-decoration: none; }
.t-link:hover { color: var(--flash-hot); text-decoration: underline; }
/* Time left before the toast closes itself. Hover pauses it. */
.ttl { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--border-strong); transform-origin: left; animation: ttl linear forwards; }
@keyframes ttl { from { transform: scaleX(1); } to { transform: scaleX(0); } }

.unlock-frame { width: 100%; height: 150px; border: 0; border-radius: 12px; background: var(--surface); color-scheme: dark; }
.hint { font-size: 11px; color: var(--faint); }
/* Stands in for the buy keys when they cannot be offered. */
.note { margin: 0; padding: 11px 12px; border-radius: 12px; background: var(--surface); color: var(--muted); font-size: 12px; line-height: 1.45; }

/* trade options: two segmented boxes */
.opts { display: flex; gap: 8px; }
.segbox { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; background: var(--surface); }
.seg-label { padding: 0 6px; color: var(--muted); font-size: 11px; font-weight: 600; }
.opt { flex: 1; min-width: 0; height: 26px; padding: 0 2px; white-space: nowrap; border-radius: 7px; border: 0; background: none; color: var(--light); cursor: pointer; font: 600 12px/1 var(--ui); transition: color .12s ease, background-color .15s ease, transform .1s var(--ease-out); }
.opt:hover:not(:disabled) { color: var(--text); background: var(--surface-2); }
.opt:active:not(:disabled) { transform: scale(.92); }
.opt[aria-pressed="true"] { color: #fff; font-weight: 700; background: var(--border-strong); animation: pick .26s var(--ease-spring); }
@keyframes pick { from { transform: scale(.9); } }
.opt:disabled { opacity: .45; cursor: not-allowed; }
.qa-edit { display: grid; gap: 8px; animation: rise .22s var(--ease-out); }
.qa-err { font-size: 11px; color: var(--sell); }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.qa-field { display: grid; gap: 3px; font-size: 11px; min-width: 0; color: var(--muted); }
.qa-input { display: flex; min-width: 0; align-items: center; gap: 4px; height: 36px; padding: 0 9px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--muted); transition: border-color .12s ease; }
.qa-input:focus-within { border-color: var(--flash); }
.qa-input input { flex: 1; width: 100%; min-width: 0; border: 0; background: none; padding: 0; font: 600 15px/1 var(--num); user-select: text; }
.qa-input input:focus { outline: none; }
.qa-input input[aria-invalid="true"] { color: var(--sell); }

@media (prefers-reduced-motion: reduce) {
  .k, .k *, .k *::before, .k *::after, .toast, .toast * { animation: none !important; transition: none !important; }
  .ttl { display: none; }
}
${exitPlanCss}
`;
