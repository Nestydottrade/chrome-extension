import { useRef } from 'preact/hooks';

/**
 * How a popup screen enters: pushed in from the right when going deeper (a wallet, a
 * ticket), popped back from the left when coming out, sliding with the tab order when
 * switching tabs, and a plain fade otherwise (first paint, lock, unlock).
 */
export type Motion = 'fade' | 'push' | 'pop' | 'next' | 'prev';

export interface ScreenPlace {
  key: string;
  /** 0 for a tab, 1 for a screen opened from it. */
  depth: number;
  /** The tab's position in the bottom bar. */
  index: number;
}

export function screenMotion(prev: ScreenPlace | null, next: ScreenPlace): Motion {
  if (!prev || prev.key === next.key) return 'fade';
  if (next.depth > prev.depth) return 'push';
  if (next.depth < prev.depth) return 'pop';
  if (next.index > prev.index) return 'next';
  if (next.index < prev.index) return 'prev';
  return 'fade';
}

/** The motion for the screen now showing; it stays the same until the screen changes. */
export function useScreenMotion(place: ScreenPlace): Motion {
  const last = useRef<{ place: ScreenPlace; motion: Motion } | null>(null);
  if (last.current?.place.key === place.key) return last.current.motion;
  const motion = screenMotion(last.current?.place ?? null, place);
  last.current = { place, motion };
  return motion;
}
