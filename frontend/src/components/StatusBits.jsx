import { initials, scoreText } from '../api';

/**
 * The small shared pieces every page leans on, in the GateLog design
 * language (see gatelog_design_system/DESIGN.md): tonal dark surfaces,
 * cyan for telemetry, emerald for "in", amber for "out".
 *
 * Kept in one file because none of them is big enough to earn its own, and
 * keeping them together makes it obvious when two pages drift apart on what
 * "out" should look like.
 */

/** A Material Symbols icon. Self-hosted, so it works with no internet. */
export function Icon({ name, className = '', fill = false }) {
  return (
    <span
      className={`material-symbols-outlined ${fill ? 'fill' : ''} ${className}`}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

/**
 * Initials in a tile. The register never stores a photograph of anybody
 * (photos are deleted the moment enrollment finishes), so there is nothing
 * else to show — and that is deliberate, not a missing feature.
 */
export function Avatar({ name, size = 'md', tone = 'neutral' }) {
  const sizes = {
    sm: 'h-7 w-7 text-code-sm',
    md: 'h-9 w-9 text-code-sm',
    lg: 'h-14 w-14 text-headline-md',
    xl: 'h-24 w-24 text-display-lg sm:h-28 sm:w-28',
  };
  const tones = {
    neutral: 'bg-surface-container-highest text-on-surface',
    in: 'bg-secondary/15 text-secondary',
    out: 'bg-tertiary/15 text-tertiary',
  };
  return (
    <div
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-code-sm font-semibold ${sizes[size]} ${tones[tone]}`}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

/** Shown while the first fetch is in flight. Polling refreshes don't use it. */
export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-space-md rounded-xl bg-surface-container px-space-md py-space-lg font-body-md text-body-md text-on-surface-variant">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

/**
 * A failed fetch, with the reason and a way out. The register is the thing a
 * manager checks at the door, so a dead end here means falling back to paper.
 */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-xl border border-tertiary/30 bg-tertiary/10 px-space-md py-space-md">
      <p className="font-body-md text-body-md font-semibold text-tertiary">
        Couldn&rsquo;t reach the register
      </p>
      <p className="mt-1 font-body-md text-body-md text-on-surface-variant">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-space-md rounded-lg border border-outline-variant bg-surface-container-high px-space-md py-1.5 font-body-md text-body-md font-medium text-on-surface hover:bg-surface-container-highest"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Nothing to show yet. The children say what would fill it. */
export function Empty({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low px-space-md py-space-xl text-center font-body-md text-body-md text-on-surface-variant">
      {children}
    </div>
  );
}

/**
 * Where a guest is right now.
 *
 * `presumed` means the register hasn't seen them since the 4am rollover, so
 * "in" is the default rather than an observation. Showing that difference
 * matters: a manager reading the board should know which rows the camera
 * actually put there. Presumed rows are neutral slate, not emerald.
 */
export function StatusPill({ status, presumed = false }) {
  const out = status === 'out';
  const tone = presumed
    ? 'bg-surface-container-highest text-on-surface-variant'
    : out
      ? 'bg-tertiary/15 text-tertiary'
      : 'bg-secondary/15 text-secondary';
  const dot = presumed ? 'bg-outline' : out ? 'bg-tertiary' : 'bg-secondary';

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 font-code-sm text-code-sm font-semibold ${tone}`}
      title={presumed ? 'Not seen since the register rolled over at 4am' : undefined}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {out ? 'OUT' : 'IN'}
      {presumed && <span className="font-normal opacity-80">(assumed)</span>}
    </span>
  );
}

/**
 * How a movement got into the register: camera (with its match score) or a
 * person. The score is cosine similarity, shown as the recogniser reports it
 * (0.62) — not as a percentage, which would read as a certainty it isn't.
 */
export function MethodBadge({ log }) {
  if (!log) return <span className="font-code-sm text-code-sm text-outline">—</span>;
  if (log.source === 'manual') {
    return (
      <span className="rounded bg-surface-container-highest px-2 py-0.5 font-code-sm text-code-sm text-on-surface-variant">
        [MANUAL]
      </span>
    );
  }
  const score = scoreText(log.confidence);
  return (
    <span className="rounded bg-surface-container-high px-2 py-0.5 font-code-sm text-code-sm text-primary">
      Camera{score && ` · ${score}`}
    </span>
  );
}

/** One number on a header strip. */
export function Metric({ label, value, hint, tone = 'neutral' }) {
  const tones = {
    neutral: 'text-on-surface',
    in: 'text-secondary',
    out: 'text-tertiary',
    cyan: 'text-primary',
  };
  return (
    <div className="rounded-xl bg-surface-container px-space-md py-space-md">
      <p className="font-label-caps text-label-caps uppercase text-on-surface-variant">{label}</p>
      <p className={`mt-1 font-headline-lg text-headline-lg tabular-nums ${tones[tone]}`}>
        {value ?? '—'}
      </p>
      {hint && <p className="mt-0.5 font-code-sm text-code-sm text-outline">{hint}</p>}
    </div>
  );
}

/** Label-caps caption used above fields and sections. */
export function Caps({ children, className = '' }) {
  return (
    <span className={`font-label-caps text-label-caps uppercase text-on-surface-variant ${className}`}>
      {children}
    </span>
  );
}
