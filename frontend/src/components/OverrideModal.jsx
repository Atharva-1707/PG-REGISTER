import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clockTimeUpper, getGuests, getSummary, logMovement, timeAgo } from '../api';
import { resolveTimestamp } from '../time';
import { Avatar, Caps, Icon, StatusPill } from './StatusBits';

/**
 * Manual entry / exit override — the fallback when the camera is down, a
 * guest isn't enrolled yet, or the register has someone on the wrong side
 * of the door.
 *
 * Entries made here are sent as source: "manual", so the history shows which
 * rows a person wrote and which the camera did.
 *
 * Deliberately not in the design: "Audit signature auto-attached" and a named
 * operator. The register has no login, so there is no signature to attach and
 * claiming one would be false. The footer says what actually happens instead.
 */

const REASONS = [
  { icon: 'luggage', label: 'Carrying luggage / umbrella' },
  { icon: 'masks', label: 'Face obstructed / mask' },
  { icon: 'visibility_off', label: 'Guest did not face lens' },
  { icon: 'flash_off', label: 'Hardware / glare glitch' },
];

const pad = (n) => String(n).padStart(2, '0');
const nowHHMM = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function OverrideModal({ initialGuestId, onClose, onDone }) {
  const [guests, setGuests] = useState([]);
  const [dayStart, setDayStart] = useState(null);
  const [selectedId, setSelectedId] = useState(initialGuestId || null);
  const [picking, setPicking] = useState(!initialGuestId);
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState(null);
  const [timeMode, setTimeMode] = useState('now');
  const [clock, setClock] = useState(nowHHMM());
  const [reason, setReason] = useState(null);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getGuests(), getSummary()])
      .then(([rows, summary]) => {
        if (!alive) return;
        setGuests(rows.filter((g) => g.active));
        setDayStart(summary.day_started);
      })
      .catch((e) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = useMemo(() => guests.find((g) => g.id === selectedId) || null, [guests, selectedId]);

  // Default to the opposite of what the register thinks — that is nearly
  // always why someone is correcting it — but never lock them into it.
  const effectiveDirection = direction || (selected ? (selected.status === 'in' ? 'out' : 'in') : null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guests.filter((g) => !q || g.name.toLowerCase().includes(q) || g.room_no.includes(q));
  }, [guests, query]);

  const choose = useCallback((guest) => {
    setSelectedId(guest.id);
    setDirection(null);
    setPicking(false);
    setQuery('');
    setError(null);
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!selected || !effectiveDirection || busy) return;

    const time = resolveTimestamp(timeMode, clock, dayStart);
    if (time.error) {
      setError(time.error);
      return;
    }

    const note = [reason, remarks.trim()].filter(Boolean).join(' — ');
    setBusy(true);
    setError(null);
    try {
      const { log } = await logMovement({
        guestId: selected.id,
        direction: effectiveDirection,
        note,
        timestamp: time.iso,
      });
      setDone({ name: selected.name, direction: log.direction, at: log.timestamp });
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    setDone(null);
    setSelectedId(null);
    setPicking(true);
    setDirection(null);
    setReason(null);
    setRemarks('');
    setTimeMode('now');
    setClock(nowHHMM());
    getGuests().then((rows) => setGuests(rows.filter((g) => g.active))).catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-surface-container-lowest/80 p-space-sm backdrop-blur-md md:p-space-lg"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-title"
        className="relative my-auto flex w-full max-w-2xl flex-col gap-space-lg overflow-hidden rounded-xl bg-surface-container-low p-space-md shadow-2xl outline-none md:p-space-lg"
      >
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-tertiary/10 blur-3xl" />

        <div className="relative z-10 flex items-start justify-between gap-space-md">
          <div className="flex items-start gap-space-md">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest text-primary">
              <Icon name="security_update_warning" fill className="text-2xl" />
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-space-xs">
                <h2 id="override-title" className="font-headline-md text-headline-md font-semibold tracking-tight">
                  Manual Entry / Exit Override
                </h2>
                <span className="rounded bg-tertiary-container/30 px-2 py-0.5 font-code-sm text-code-sm font-semibold uppercase tracking-wider text-tertiary">
                  System Fallback
                </span>
              </div>
              <p className="mt-0.5 max-w-lg font-body-sm text-body-sm text-on-surface-variant">
                Use this when the camera is down, missed someone, or got a direction wrong. The row is
                marked <span className="font-code-sm text-code-sm text-tertiary">[MANUAL]</span> in the
                register.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
          >
            <Icon name="close" className="text-lg" />
          </button>
        </div>

        {loadError && (
          <p className="relative z-10 rounded-lg bg-tertiary/10 px-space-md py-space-sm font-body-md text-body-md text-tertiary">
            Couldn&rsquo;t load the guest list: {loadError}
          </p>
        )}

        {done ? (
          <div className="relative z-10 flex flex-col gap-space-md">
            <div className="flex items-start gap-space-md rounded-xl bg-secondary/10 px-space-md py-space-md">
              <Icon name="check_circle" fill className="text-2xl text-secondary" />
              <div>
                <p className="font-body-lg text-body-lg font-semibold text-secondary">
                  {done.name} marked {done.direction === 'in' ? 'IN' : 'OUT'}
                </p>
                <p className="mt-0.5 font-code-tabular text-code-tabular text-on-surface-variant">
                  {clockTimeUpper(done.at)} · recorded as [MANUAL]
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-space-sm">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg bg-surface-container px-space-lg py-2.5 font-body-md text-body-md text-on-surface transition-colors hover:bg-surface-container-high"
              >
                Log another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-primary px-space-xl py-2.5 font-body-md text-body-md font-semibold text-on-primary transition-colors hover:bg-primary-fixed"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="relative z-10 flex flex-col gap-space-lg">
            {/* 1. guest */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Caps>1. Guest ({guests.length} enrolled)</Caps>
              </div>
              <div className="rounded-lg bg-surface-container p-space-sm">
                {selected ? (
                  <div className="flex items-center justify-between gap-space-sm">
                    <div className="flex min-w-0 items-center gap-space-md">
                      <Avatar name={selected.name} tone={selected.status === 'out' ? 'out' : 'in'} />
                      <div className="flex min-w-0 flex-col">
                        <div className="flex items-center gap-space-xs">
                          <span className="truncate font-body-lg text-body-lg font-semibold">
                            {selected.name}
                          </span>
                          <span className="rounded bg-surface-container-high px-1.5 py-0.5 font-code-sm text-code-sm text-on-surface-variant">
                            RM-{selected.room_no}
                          </span>
                        </div>
                        <span className="font-code-sm text-code-sm text-outline">
                          Register has them {selected.presumed ? 'in (assumed)' : selected.status} · last seen{' '}
                          {timeAgo(selected.last_seen)}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPicking((p) => !p)}
                      className="flex shrink-0 items-center gap-1 rounded bg-surface-container-high px-space-md py-1.5 font-code-sm text-code-sm text-primary transition-colors hover:bg-surface-container-highest"
                    >
                      Switch guest
                      <Icon name="unfold_more" className="text-sm" />
                    </button>
                  </div>
                ) : (
                  <p className="px-space-sm py-1 font-body-md text-body-md text-on-surface-variant">
                    Pick a guest below.
                  </p>
                )}

                {picking && (
                  <div className="mt-space-sm flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg bg-surface-container-lowest p-space-xs">
                    <div className="mb-1 flex items-center gap-space-sm rounded bg-surface-container-high px-space-sm py-1.5">
                      <Icon name="search" className="text-sm text-on-surface-variant" />
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Type a name or room number…"
                        className="w-full bg-transparent font-body-sm text-body-sm text-on-surface outline-none placeholder:text-outline"
                      />
                    </div>
                    {matches.length === 0 && (
                      <p className="px-space-sm py-2 font-body-sm text-body-sm text-on-surface-variant">
                        No guest matches that.
                      </p>
                    )}
                    {matches.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => choose(g)}
                        className="flex items-center justify-between gap-space-sm rounded p-space-sm text-left transition-colors hover:bg-surface-container-high"
                      >
                        <span className="flex min-w-0 items-center gap-space-sm">
                          <Avatar name={g.name} size="sm" />
                          <span className="truncate font-body-sm text-body-sm font-medium">
                            {g.name} <span className="text-outline">(Room {g.room_no})</span>
                          </span>
                        </span>
                        <StatusPill status={g.status} presumed={g.presumed} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 2. direction */}
            <div className="flex flex-col gap-1.5">
              <Caps>2. Which way did they go?</Caps>
              <div className="grid grid-cols-2 gap-space-sm rounded-xl bg-surface-container p-1">
                {[
                  { key: 'in', icon: 'login', title: 'IN / ENTERED', sub: 'Hostel arrival', on: 'bg-secondary text-on-secondary' },
                  { key: 'out', icon: 'logout', title: 'OUT / EXITED', sub: 'Hostel departure', on: 'bg-tertiary text-on-tertiary' },
                ].map((opt) => {
                  const active = effectiveDirection === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      aria-pressed={active}
                      disabled={!selected}
                      onClick={() => setDirection(opt.key)}
                      className={`flex items-center justify-center gap-space-sm rounded-lg py-space-md font-headline-md text-headline-md font-semibold transition-all disabled:opacity-50 ${
                        active
                          ? `${opt.on} shadow-lg`
                          : 'bg-transparent text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      <Icon name={opt.icon} className="text-2xl" />
                      <span className="flex flex-col items-start leading-none">
                        <span>{opt.title}</span>
                        <span className="font-code-sm text-code-sm font-normal opacity-80">{opt.sub}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 3. time */}
            <div className="flex flex-col gap-1.5">
              <Caps>3. When did it happen?</Caps>
              <div className="grid grid-cols-1 gap-space-sm md:grid-cols-2">
                <label
                  className={`flex cursor-pointer items-center gap-space-sm rounded-lg bg-surface-container p-space-md transition-all ${
                    timeMode === 'now' ? 'ring-1 ring-primary' : 'opacity-85 hover:opacity-100'
                  }`}
                >
                  <input
                    type="radio"
                    name="override_time"
                    checked={timeMode === 'now'}
                    onChange={() => setTimeMode('now')}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="flex flex-col">
                    <span className="flex items-center gap-1.5 font-body-md text-body-md font-semibold">
                      <span className="h-2 w-2 rounded-full bg-secondary" /> Right now
                    </span>
                    <span className="font-code-tabular text-code-tabular text-primary">
                      The server stamps the time
                    </span>
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer items-center gap-space-sm rounded-lg bg-surface-container p-space-md transition-all ${
                    timeMode === 'custom' ? 'ring-1 ring-primary' : 'opacity-85 hover:opacity-100'
                  }`}
                >
                  <input
                    type="radio"
                    name="override_time"
                    checked={timeMode === 'custom'}
                    onChange={() => setTimeMode('custom')}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="flex flex-1 flex-col">
                    <span className="font-body-md text-body-md font-medium">Earlier today</span>
                    <span className="mt-1 flex items-center gap-2">
                      <input
                        type="time"
                        value={clock}
                        onChange={(e) => {
                          setClock(e.target.value);
                          setTimeMode('custom');
                        }}
                        className="rounded bg-surface-container-highest px-2 py-0.5 font-code-tabular text-code-tabular text-on-surface outline-none [color-scheme:dark]"
                      />
                      <span className="font-code-sm text-code-sm text-outline">
                        since {dayStart ? clockTimeUpper(dayStart) : '4:00 AM'}
                      </span>
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* 4. reason */}
            <div className="flex flex-col gap-space-xs">
              <Caps>4. Why by hand? (optional)</Caps>
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((r) => {
                  const active = reason === r.label;
                  return (
                    <button
                      key={r.label}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setReason(active ? null : r.label)}
                      className={`flex items-center gap-1.5 rounded-lg px-space-sm py-1.5 font-body-sm text-body-sm transition-all ${
                        active
                          ? 'bg-primary font-medium text-on-primary'
                          : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
                      }`}
                    >
                      <Icon name={r.icon} className="text-base" />
                      {r.label}
                    </button>
                  );
                })}
              </div>
              <input
                value={remarks}
                maxLength={160}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Additional remarks (e.g. came back by taxi with parents)…"
                className="mt-1 w-full rounded-lg bg-surface-container px-space-md py-2 font-body-sm text-body-sm text-on-surface outline-none transition-colors placeholder:text-outline focus:bg-surface-container-highest focus:ring-1 focus:ring-primary"
              />
            </div>

            {error && (
              <p role="alert" className="rounded-lg bg-error-container/40 px-space-md py-space-sm font-body-md text-body-md text-on-error-container">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-space-sm rounded-lg bg-surface-container-lowest p-space-sm font-code-sm text-code-sm text-on-surface-variant">
              <span className="flex items-center gap-space-sm">
                <Icon name="badge" className="text-base text-primary" />
                Recorded as <strong className="text-on-surface">[MANUAL]</strong>
              </span>
              <span className="hidden text-outline sm:inline">No camera match score attached</span>
            </div>

            <div className="flex items-center justify-between pt-space-xs">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-surface-container px-space-lg py-2.5 font-body-md text-body-md text-on-surface transition-colors hover:bg-surface-container-high"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!selected || !effectiveDirection || busy}
                className="flex items-center gap-2 rounded-lg bg-primary px-space-xl py-2.5 font-headline-md text-headline-md font-semibold text-on-primary transition-colors hover:bg-primary-fixed disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="bolt" />
                {busy ? 'Logging…' : 'Confirm & Log Override'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
