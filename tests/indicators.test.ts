import { describe, expect, it } from 'vitest';
import { ema, rsi, vwap, type StudyBar } from '../src/shared/indicators';

const DAY = 86_400;

/** Candles a minute apart from `start`, high and low at the close, $100 traded in each. */
const closes = (list: readonly number[], start = 0): StudyBar[] =>
  list.map((close, i) => ({ time: start + i * 60, high: close, low: close, close, volume: 100 }));

const values = (points: readonly { value: number }[]) => points.map((p) => p.value);

describe('ema', () => {
  it('starts at the plain average, then moves 2 / (length + 1) of the way to each close', () => {
    const out = ema(closes([1, 2, 3, 4, 5]), 3);
    expect(out.map((p) => p.time)).toEqual([120, 180, 240]);
    expect(values(out)).toEqual([2, 3, 4]);
  });

  it('has nothing until enough candles are in', () => {
    expect(ema(closes([1, 2]), 3)).toEqual([]);
    expect(ema([], 9)).toEqual([]);
  });

  it('stays put on a flat series and follows a factor', () => {
    expect(values(ema(closes([7, 7, 7, 7, 7, 7]), 3))).toEqual([7, 7, 7, 7]);
    const plain = values(ema(closes([3, 1, 4, 1, 5, 9, 2, 6]), 4));
    const scaled = values(ema(closes([3, 1, 4, 1, 5, 9, 2, 6].map((c) => c * 1e6)), 4));
    scaled.forEach((v, i) => expect(v).toBeCloseTo((plain[i] as number) * 1e6, 3));
  });

  it('passes over a candle with no close', () => {
    const bars = closes([1, 2, 3, 4]);
    bars.splice(2, 0, { time: 90, high: 0, low: 0, close: Number.NaN, volume: 0 });
    expect(values(ema(bars, 3))).toEqual([2, 3]);
  });

  it('refuses a length that is not a whole number above zero', () => {
    expect(() => ema(closes([1, 2, 3]), 0)).toThrow(RangeError);
    expect(() => ema(closes([1, 2, 3]), 2.5)).toThrow(RangeError);
  });
});

describe('vwap', () => {
  it('weighs each candle by the tokens its dollars bought', () => {
    const out = vwap([
      { time: 0, high: 12, low: 8, close: 10, volume: 100 },
      { time: 60, high: 20, low: 20, close: 20, volume: 300 },
    ]);
    // $100 bought 10 tokens at 10, $300 bought 15 at 20: $400 for 25 tokens.
    expect(values(out)).toEqual([10, 16]);
    expect(out.map((p) => p.fresh)).toEqual([false, false]);
  });

  it('starts again at 00:00 UTC, and marks where', () => {
    const out = vwap([
      { time: DAY - 60, high: 10, low: 10, close: 10, volume: 50 },
      { time: DAY, high: 30, low: 30, close: 30, volume: 60 },
      { time: DAY + 60, high: 60, low: 60, close: 60, volume: 120 },
    ]);
    // The new day: $60 for 2 tokens, then $180 for 4.
    expect(values(out)).toEqual([10, 30, 45]);
    expect(out.map((p) => p.fresh)).toEqual([false, true, false]);
  });

  it('waits for a day to trade before it has a value', () => {
    const out = vwap([
      { time: 0, high: 5, low: 5, close: 5, volume: 10 },
      { time: DAY, high: 9, low: 9, close: 9, volume: 0 },
      { time: DAY + 60, high: 8, low: 8, close: 8, volume: 16 },
    ]);
    expect(out.map((p) => [p.time, p.value, p.fresh])).toEqual([
      [0, 5, false],
      [DAY + 60, 8, true],
    ]);
  });

  it('follows prices scaled to a market cap', () => {
    const bars: StudyBar[] = [
      { time: 0, high: 0.0012, low: 0.001, close: 0.0011, volume: 250 },
      { time: 60, high: 0.0015, low: 0.0011, close: 0.0014, volume: 900 },
    ];
    const plain = values(vwap(bars));
    const supply = 1e9;
    const scaled = values(
      vwap(
        bars.map((b) => ({
          ...b,
          high: b.high * supply,
          low: b.low * supply,
          close: b.close * supply,
        })),
      ),
    );
    scaled.forEach((v, i) => expect(v / supply).toBeCloseTo(plain[i] as number, 12));
  });
});

describe('rsi', () => {
  it('smooths rises and falls as Wilder did', () => {
    const out = rsi(closes([10, 11, 10.5, 12, 12, 11]), 2);
    expect(out.map((p) => p.time)).toEqual([120, 180, 240, 300]);
    // Rise 0.5 and fall 0.25 at first; then 1 and 0.125; 0.5 and 0.0625; 0.25 and 0.53125.
    const want = [100 - 100 / 3, 100 - 100 / 9, 100 - 100 / 9, 32];
    values(out).forEach((v, i) => expect(v).toBeCloseTo(want[i] as number, 9));
  });

  it('gives the textbook first value over 14 changes', () => {
    const series = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28,
    ];
    const out = rsi(closes(series));
    expect(out).toHaveLength(1);
    // Rises 3.34 and falls 1.40 over 14 changes.
    expect(out[0]?.value).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 9);
    expect(out[0]?.value).toBeCloseTo(70.46, 2);
  });

  it('reads 100 when nothing fell and 0 when nothing rose', () => {
    expect(values(rsi(closes([1, 2, 3, 4]), 2))).toEqual([100, 100]);
    expect(values(rsi(closes([4, 3, 2, 1]), 2))).toEqual([0, 0]);
    expect(values(rsi(closes([5, 5, 5]), 2))).toEqual([100]);
  });

  it('has nothing until it has enough changes', () => {
    expect(rsi(closes([1, 2, 3]), 3)).toEqual([]);
    expect(rsi(closes([1, 2, 3, 4]), 3)).toHaveLength(1);
  });
});
