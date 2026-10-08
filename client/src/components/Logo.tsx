/**
 * The Küü wordmark. Letters are terracotta on light backgrounds and cream on the dark
 * sidebar; the dots above the ü's are always the brand peach.
 */
export function Logo({ height = 28, onDark = false, className = '' }: { height?: number; onDark?: boolean; className?: string }) {
  return (
    <svg
      className={`logo ${className}`}
      viewBox="318 290 874 356"
      height={height}
      width={(height * 874) / 356}
      role="img"
      aria-label="Küü"
      style={{ color: onDark ? 'var(--brand-cream)' : 'var(--brand-terracotta)' }}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M377 345V588" strokeWidth={94} />
        <path d="M436 468L588 340M470 498L597 594" strokeWidth={80} />
        <path d="M683 448V505A85 85 0 0 0 853 505V448" strokeWidth={84} />
        <path d="M967 448V505A85 85 0 0 0 1137 505V448" strokeWidth={84} />
      </g>
      <g fill="var(--brand-peach)">
        <circle cx={709} cy={342} r={42} />
        <circle cx={827} cy={342} r={42} />
        <circle cx={991} cy={342} r={42} />
        <circle cx={1103} cy={342} r={42} />
      </g>
    </svg>
  );
}

/** The square Küü app icon (terracotta tile, cream ü, peach dots), for tight spaces such as the docked sidebar. */
export function LogoMark({ size = 30, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`logo ${className}`} viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="Küü">
      <rect width="64" height="64" rx="15" fill="var(--brand-terracotta)" />
      <path d="M20 31V38A12 12 0 0 0 44 38V31" fill="none" stroke="var(--brand-cream)" strokeWidth={11} strokeLinecap="round" />
      <circle cx="23" cy="16.5" r="5.5" fill="var(--brand-peach)" />
      <circle cx="41" cy="16.5" r="5.5" fill="var(--brand-peach)" />
    </svg>
  );
}

export const TAGLINE = 'Work moves forward together.';
