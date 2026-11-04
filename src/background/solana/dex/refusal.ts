/** Where a program would fail the swap; the quote becomes 0 (cannot fill). */
class Refused extends Error {}

export function refuse(): never {
  throw new Refused('refused');
}

/** Runs a quote, 0 when the program would refuse the trade. */
export function quoteOrZero(f: () => bigint): bigint {
  try {
    return f();
  } catch (e) {
    if (e instanceof Refused) return 0n;
    throw e;
  }
}
