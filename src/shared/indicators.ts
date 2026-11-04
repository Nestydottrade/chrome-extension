/**
 * Studies drawn over a chart's candles: exponential moving averages of the closes, the
 * volume-weighted average price from the start of each UTC day, and the relative strength
 * index. Arithmetic only: candles come in oldest first, one per time, and a candle whose
 * close is not a number is passed over.
 */

/** A candle as the studies read it. */
export interface StudyBar {
  /** Unix seconds at its start. */
  time: number;
  high: number;
  low: number;
  close: number;
  /** What traded in it, in dollars. */
  volume: number;
}

/** A study's value at a candle. */
export interface StudyPoint {
  time: number;
  value: number;
}

const usable = (bars: readonly StudyBar[]) => bars.filter((b) => Number.isFinite(b.close));

function checkLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) throw new RangeError(`bad length ${length}`);
}

/**
 * The exponential moving average of the closes over `length` candles. It starts as the
 * plain average of the first `length` closes; each candle after moves it 2 / (length + 1)
 * of the way to its close. Nothing before the `length`th candle.
 */
export function ema(bars: readonly StudyBar[], length: number): StudyPoint[] {
  checkLength(length);
  const list = usable(bars);
  const out: StudyPoint[] = [];
  if (list.length < length) return out;
  let value = 0;
  for (let i = 0; i < length; i++) value += (list[i] as StudyBar).close;
  value /= length;
  out.push({ time: (list[length - 1] as StudyBar).time, value });
  const alpha = 2 / (length + 1);
  for (let i = length; i < list.length; i++) {
    const b = list[i] as StudyBar;
    value += alpha * (b.close - value);
    out.push({ time: b.time, value });
  }
  return out;
}

/** A VWAP value; `fresh` marks the first one of a new day, where the line starts again. */
export interface VwapPoint extends StudyPoint {
  fresh: boolean;
}

/**
 * The volume-weighted average price, starting again at 00:00 UTC each day: the dollars
 * traded since the day began over the tokens they bought, each candle's tokens taken as
 * its dollars at its typical price, (high + low + close) / 3. Prices scaled by a factor
 * (a market cap) give the same average scaled by it. A day has no value until something
 * traded in it.
 */
export function vwap(bars: readonly StudyBar[]): VwapPoint[] {
  const out: VwapPoint[] = [];
  let day = Number.NaN;
  let dollars = 0;
  let tokens = 0;
  let fresh = false;
  for (const b of usable(bars)) {
    const d = Math.floor(b.time / 86_400);
    if (d !== day) {
      fresh = !Number.isNaN(day);
      day = d;
      dollars = 0;
      tokens = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    if (b.volume > 0 && typical > 0 && Number.isFinite(b.volume) && Number.isFinite(typical)) {
      dollars += b.volume;
      tokens += b.volume / typical;
    }
    if (tokens <= 0) continue;
    out.push({ time: b.time, value: dollars / tokens, fresh });
    fresh = false;
  }
  return out;
}

/** 100 when nothing fell, 0 when nothing rose; as TradingView's RSI has it. */
const strength = (up: number, down: number) =>
  down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);

/**
 * The relative strength index of the closes over `length` candles, with Wilder's
 * smoothing: the first average rise and fall are plain averages over `length` changes, and
 * each after keeps (length − 1) / length of the one before. Nothing before the candle that
 * makes `length` changes.
 */
export function rsi(bars: readonly StudyBar[], length = 14): StudyPoint[] {
  checkLength(length);
  const list = usable(bars);
  const out: StudyPoint[] = [];
  if (list.length <= length) return out;
  const change = (i: number) => (list[i] as StudyBar).close - (list[i - 1] as StudyBar).close;
  let up = 0;
  let down = 0;
  for (let i = 1; i <= length; i++) {
    const c = change(i);
    if (c > 0) up += c;
    else down -= c;
  }
  up /= length;
  down /= length;
  out.push({ time: (list[length] as StudyBar).time, value: strength(up, down) });
  for (let i = length + 1; i < list.length; i++) {
    const c = change(i);
    up = (up * (length - 1) + Math.max(c, 0)) / length;
    down = (down * (length - 1) + Math.max(-c, 0)) / length;
    out.push({ time: (list[i] as StudyBar).time, value: strength(up, down) });
  }
  return out;
}
