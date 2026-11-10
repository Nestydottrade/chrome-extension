import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SOLANA_CHAIN_ID } from '../../shared/solana';
import { send } from '../../ui/api';
import { IconCheck, IconChevronDown, IconClose } from './icons';

export interface PickerOption<T extends string | number> {
  value: T;
  label: string;
  /** Second line, e.g. an address or a balance. */
  sub?: string | undefined;
  /** Leading mark (chain mark, avatar). */
  mark?: ComponentChildren;
  disabled?: boolean | undefined;
  /** Why it is disabled, shown instead of `sub`. */
  disabledNote?: string | undefined;
}

/**
 * Replacement for <select>: a trigger button that opens a modal sheet from the bottom
 * of the popup. Built on <dialog>.showModal(), so focus stays inside, Esc closes and
 * the rest of the popup is inert while it is open.
 */
export function Picker<T extends string | number>({
  title,
  value,
  options,
  onChange,
  variant = 'field',
  id,
}: {
  /** Sheet title and the trigger's accessible name, e.g. "Select chain". */
  title: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (v: T) => void;
  /** pill: header chain switch; field: full-width form field; compact: inline in a card. */
  variant?: 'pill' | 'field' | 'compact';
  id?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  const onOpened = () => {
    // Start on the selected row so arrows and Enter work right away.
    const sel = list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    (sel ?? list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  };

  const pick = (o: PickerOption<T>) => {
    if (o.disabled) return;
    setOpen(false);
    if (o.value !== value) onChange(o.value);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const rows = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <>
      <button
        type="button"
        id={id}
        class={`pick pick--${variant}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title}: ${current?.label ?? 'none'}`}
        onClick={() => setOpen(true)}
      >
        {current?.mark}
        <span class="pick-label">{current?.label ?? 'Select'}</span>
        <IconChevronDown size={14} class="pick-chev" />
      </button>
      <Sheet title={title} open={open} onClose={() => setOpen(false)} onOpened={onOpened}>
        <div class="sheet-list" ref={list} onKeyDown={onKey}>
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                class="sheet-row"
                aria-current={selected}
                disabled={o.disabled}
                onClick={() => pick(o)}
              >
                {o.mark}
                <span class="sheet-text">
                  <span>{o.label}</span>
                  {(o.disabled ? o.disabledNote : o.sub) && (
                    <small>{o.disabled ? o.disabledNote : o.sub}</small>
                  )}
                </span>
                {selected && <IconCheck size={16} class="sheet-check" />}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}

/**
 * Modal sheet from the bottom of the popup, built on <dialog>.showModal(): focus stays
 * inside, Esc closes, and a click on the backdrop closes.
 */
export function Sheet({
  title,
  open,
  onClose,
  onOpened,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onOpened?: () => void;
  children: ComponentChildren;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      onOpened?.();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      class="sheet"
      aria-label={title}
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself.
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <div class="sheet-body">
        <div class="sheet-head">
          <span class="sheet-title">{title}</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/**
 * Brand colour and short mark per chain, so chains are told apart at a glance: shown until
 * the chain's logo is in, and instead of it when logos are off or out of reach.
 */
const CHAIN_MARKS: Record<number, { bg: string; fg: string; text: string }> = {
  1: { bg: '#627eea', fg: '#fff', text: 'E' },
  8453: { bg: '#0052ff', fg: '#fff', text: 'B' },
  56: { bg: '#f0b90b', fg: '#1a1405', text: 'B' },
  4663: { bg: '#ccff00', fg: '#0c1400', text: 'R' },
  99901: { bg: '#97fce4', fg: '#062a22', text: 'E' },
  42161: { bg: '#28a0f0', fg: '#fff', text: 'A' },
  [SOLANA_CHAIN_ID]: { bg: 'linear-gradient(135deg, #9945ff, #14f195)', fg: '#fff', text: 'S' },
};

/** Chain logos the background answered this popup session (null: none), and those asked. */
const chainLogos = new Map<number, string | null>();
const chainLoads = new Map<number, Promise<string | null>>();

function loadChainLogo(chainId: number): Promise<string | null> {
  let load = chainLoads.get(chainId);
  if (!load) {
    load = send({ type: 'logo.chain', chainId }).then((r) => {
      const url = r.ok && r.data?.startsWith('data:image/') ? r.data : null;
      chainLogos.set(chainId, url);
      return url;
    });
    chainLoads.set(chainId, load);
  }
  return load;
}

export function ChainMark({ chainId, size = 20 }: { chainId: number | 'all'; size?: number }) {
  // Known logos show at once, so marks that mount again do not flash their letter.
  const known = chainId === 'all' ? null : (chainLogos.get(chainId) ?? null);
  const [logo, setLogo] = useState<string | null>(known);
  useEffect(() => {
    setLogo(known);
    if (chainId === 'all' || chainLogos.has(chainId)) return;
    let alive = true;
    void loadChainLogo(chainId).then((url) => {
      if (alive) setLogo(url);
    });
    return () => {
      alive = false;
    };
  }, [chainId]);

  if (logo)
    return (
      <img
        class="chain-mark is-logo"
        src={logo}
        alt=""
        aria-hidden="true"
        style={{ width: `${size}px`, height: `${size}px` }}
      />
    );
  const m =
    chainId === 'all'
      ? { bg: 'var(--surface-2)', fg: 'var(--muted)', text: '∗' }
      : (CHAIN_MARKS[chainId] ?? { bg: 'var(--surface-2)', fg: 'var(--muted)', text: '?' });
  return (
    <span
      class="chain-mark"
      aria-hidden="true"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: m.bg,
        color: m.fg,
        fontSize: `${Math.round(size * 0.55)}px`,
      }}
    >
      {m.text}
    </span>
  );
}
