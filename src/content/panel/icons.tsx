import type { ComponentChildren } from 'preact';

// Small line icons for the panel. Inline SVG: nothing to fetch, nothing for a page's CSP to block.

function Svg({ size = 14, children }: { size?: number; children: ComponentChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const MinusIcon = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
);

export const ExpandIcon = () => (
  <Svg>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const ChevronIcon = () => (
  <Svg size={10}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg size={12}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);

export const RouteIcon = () => (
  <Svg size={13}>
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="6" r="2" />
    <path d="M7 18h6a4 4 0 0 0 4-4V8" />
  </Svg>
);

export const BoltIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
  </svg>
);

export const ArrowIcon = ({ up }: { up: boolean }) => (
  <Svg size={10}>
    {up ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
  </Svg>
);
