import { formatDuration } from '../shared/format';
import type { TicketLeg } from '../shared/panel';

type Phases = NonNullable<TicketLeg['phases']>;

/** The four parts of a send, in order, with the colour each has in the strip. */
export const SPEED_PARTS = [
  { key: 'prepMs', label: 'Route', color: '#a6f4d5' },
  { key: 'checkMs', label: 'Checks', color: '#2ee6a8' },
  { key: 'signMs', label: 'Sign', color: '#169c71' },
  { key: 'sendMs', label: 'Network', color: '#2e3a50' },
] as const satisfies readonly { key: keyof Phases; label: string; color: string }[];

/**
 * Where the time of one send went, as a bar split in proportion: Nesty's three parts in
 * greens, the network's in slate. Decorative: the numbers are always shown beside it.
 */
export function SpeedStrip({ phases }: { phases: Phases }) {
  const total = SPEED_PARTS.reduce((s, p) => s + phases[p.key], 0) || 1;
  return (
    <span class="spd" aria-hidden="true">
      {SPEED_PARTS.map((p) => (
        <i key={p.key} style={{ flexGrow: phases[p.key] / total, background: p.color }} />
      ))}
    </span>
  );
}

/** The same four parts as labelled numbers. */
export function SpeedLegend({ phases }: { phases: Phases }) {
  return (
    <span class="spd-legend">
      {SPEED_PARTS.map((p) => (
        <span key={p.key}>
          <b>{formatDuration(phases[p.key])}</b>
          <span>
            <i style={{ background: p.color }} />
            {p.label}
          </span>
        </span>
      ))}
    </span>
  );
}
