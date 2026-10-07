import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { awayDurations, clockTimeUpper, dayWord, formatDuration, getGuest, scoreText, timeAgo } from '../api';
import { useOverride } from '../components/OverrideContext';
import { Avatar, Caps, Empty, ErrorState, Icon, Loading, StatusPill } from '../components/StatusBits';

/**
 * One guest's full in/out history, from the GateLog "guest timeline" design.
 *
 * Every figure on this page is computed from the movements the register
 * actually holds. In the mockup but deliberately absent, because there is no
 * data behind them: curfew, curfew compliance, "good standing", assigned
 * curfew, an emergency contact, per-event camera thumbnails (frames are never
 * stored), "ID match tokens", gate response times, a routine/curfew analysis,
 * and PDF export / profile editing (no routes for either).
 *
 * Match scores are shown as the recogniser reports them — cosine similarity,
 * e.g. 0.62 — not as percentages.
 */

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const RANGES = [
  { key: 'today', label: () => `Today (${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})` },
  { key: 'yesterday', label: () => 'Yesterday' },
  { key: 'week', label: () => 'Last 7 days' },
  { key: 'all', label: () => 'All history' },
];

function inRange(iso, range, now = new Date()) {
  const t = new Date(iso);
  const today = startOfDay(now);
  if (range === 'today') return t >= today;
  if (range === 'yesterday') {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return t >= y && t < today;
  }
  if (range === 'week') return t >= new Date(now.getTime() - 7 * 864e5);
  return true;
}

function Stat({ label, value, tone = 'text-on-surface', hint }) {
  return (
    <div className="flex flex-col">
      <span className="font-code-sm text-code-sm uppercase text-outline">{label}</span>
      <span className={`mt-0.5 font-headline-md text-headline-md font-semibold ${tone}`}>{value}</span>
      {hint && <span className="font-code-sm text-code-sm text-outline">{hint}</span>}
    </div>
  );
}

export default function GuestDetail() {
  const { id } = useParams();
  const { open: openOverride, tick } = useOverride();
  const [guest, setGuest] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('week');
  const [kind, setKind] = useState('all');

  const load = useCallback(
    (initial) => {
      setError(null);
      if (initial) setLoading(true);
      return getGuest(id)
        .then(setGuest)
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [id]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  // A manual entry saved from the dialog should show up here without a refresh.
  useEffect(() => {
    if (tick > 0) load(false);
  }, [tick, load]);

  const logs = guest?.logs ?? [];
  const away = useMemo(() => awayDurations(logs), [logs]);

  const stats = useMemo(() => {
    const now = new Date();
    const week = logs.filter((l) => inRange(l.timestamp, 'week', now));
    const exits = week.filter((l) => l.direction === 'out').length;
    const gaps = week.map((l) => away.get(l.id)).filter((g) => g != null);
    const camera = logs.filter((l) => l.source !== 'manual' && l.confidence != null);
    const avgMatch = camera.length
      ? camera.reduce((sum, l) => sum + Number(l.confidence), 0) / camera.length
      : null;
    return {
      exits,
      avgAway: gaps.length ? formatDuration(gaps.reduce((a, b) => a + b, 0) / gaps.length) : '—',
      avgMatch,
      cameraReads: camera.length,
      today: logs.filter((l) => inRange(l.timestamp, 'today', now)).length,
    };
  }, [logs, away]);

  const ranged = useMemo(() => logs.filter((l) => inRange(l.timestamp, range)), [logs, range]);
  const counts = useMemo(
    () => ({
      all: ranged.length,
      in: ranged.filter((l) => l.direction === 'in').length,
      out: ranged.filter((l) => l.direction === 'out').length,
      manual: ranged.filter((l) => l.source === 'manual').length,
    }),
    [ranged]
  );
  const shown = useMemo(
    () =>
      ranged.filter((l) =>
        kind === 'all' ? true : kind === 'manual' ? l.source === 'manual' : l.direction === kind
      ),
    [ranged, kind]
  );

  if (loading) return <div className="p-gutter"><Loading /></div>;
  if (error && !guest) return <div className="p-gutter"><ErrorState message={error} onRetry={() => load(true)} /></div>;
  if (!guest) return null;

  const out = guest.status === 'out';
  const lastLog = logs[0];

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      <div className="flex items-center justify-between gap-space-sm">
        <Link
          to="/"
          className="group flex items-center gap-space-xs rounded bg-surface-container-low px-3 py-1.5 font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant transition-colors hover:bg-surface-container hover:text-primary"
        >
          <Icon name="arrow_back" className="text-base transition-transform group-hover:-translate-x-0.5" />
          Back to Live Dashboard
        </Link>
        <div className="hidden items-center gap-space-sm font-code-sm text-code-sm text-outline sm:flex">
          <span>GUEST ID:</span>
          <span className="rounded bg-surface-container-high px-2 py-0.5 font-code-tabular text-code-tabular text-primary">
            {guest.id}
          </span>
        </div>
      </div>

      {/* header card */}
      <div className="relative overflow-hidden rounded-xl bg-surface-container p-space-lg shadow-xl">
        <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-primary-container/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-secondary-container/10 blur-3xl" />

        <div className="relative z-10 grid grid-cols-1 items-center gap-space-lg lg:grid-cols-12">
          <div className="flex flex-col items-start gap-space-lg sm:flex-row sm:items-center lg:col-span-5">
            <Avatar name={guest.name} size="xl" tone={out ? 'out' : 'in'} />
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate font-headline-lg text-headline-lg">{guest.name}</h1>
              <div className="mt-1 flex items-center gap-1.5 font-body-md text-body-md text-on-surface-variant">
                <Icon name="apartment" className="text-sm text-primary" />
                Room {guest.room_no}
              </div>
              {guest.phone && (
                <div className="mt-1 flex items-center gap-1.5 font-code-tabular text-code-tabular text-on-surface">
                  <Icon name="call" className="text-sm text-tertiary" />
                  {guest.phone}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md lg:col-span-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusPill status={guest.status} presumed={guest.presumed} />
              <span className="font-code-sm text-code-sm text-on-surface-variant">
                {lastLog
                  ? `${out ? 'Left' : 'Back'} ${dayWord(lastLog.timestamp).toLowerCase()} ${clockTimeUpper(lastLog.timestamp)}`
                  : 'No movements yet'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-space-sm pt-2">
              <div className="rounded bg-surface-container px-space-sm py-2">
                <div className="font-code-sm text-code-sm uppercase text-outline">Moves today</div>
                <div className="font-headline-md text-headline-md font-bold text-primary">{stats.today}</div>
              </div>
              <div className="rounded bg-surface-container px-space-sm py-2">
                <div className="font-code-sm text-code-sm uppercase text-outline">Avg camera match</div>
                <div className="font-headline-md text-headline-md font-bold text-secondary">
                  {stats.avgMatch == null ? '—' : stats.avgMatch.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-center gap-space-xs lg:col-span-3">
            {guest.active ? (
              <button
                type="button"
                onClick={() => openOverride({ guestId: guest.id })}
                className="flex w-full items-center justify-center gap-2 rounded bg-primary px-space-md py-2.5 font-label-caps text-label-caps uppercase tracking-wider text-on-primary shadow-md transition-colors hover:bg-primary-fixed"
              >
                <Icon name="how_to_reg" className="text-base" /> Log Manual Entry
              </button>
            ) : (
              <p className="rounded bg-surface-container-low px-space-md py-2 text-center font-body-sm text-body-sm text-on-surface-variant">
                Moved out — no further entries
              </p>
            )}
            {guest.active && (
              <Link
                to={`/outpass?guest=${encodeURIComponent(guest.id)}`}
                className="flex w-full items-center justify-center gap-2 rounded bg-surface-container-high px-space-md py-2.5 font-label-caps text-label-caps uppercase tracking-wider text-on-surface transition-colors hover:bg-surface-container-highest"
              >
                <Icon name="badge" className="text-base" /> Issue Outpass
              </Link>
            )}
          </div>
        </div>

        <div className="relative z-10 mt-space-md grid grid-cols-2 gap-space-md rounded-lg bg-surface-container-lowest/50 p-space-sm sm:grid-cols-4">
          <Stat label="Exits, last 7 days" value={`${stats.exits} ${stats.exits === 1 ? 'exit' : 'exits'}`} />
          <Stat label="Average time away" value={stats.avgAway} hint="completed outings, 7 days" />
          <Stat label="Last seen" value={timeAgo(guest.last_seen)} tone="text-secondary" />
          <Stat
            label="Enrolled"
            value={guest.enrolled_at ? new Date(guest.enrolled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
            tone="text-tertiary"
          />
        </div>
      </div>

      {!guest.active && (
        <p className="rounded-xl bg-surface-container p-space-md font-body-md text-body-md text-on-surface-variant">
          This guest has moved out. Their face data has been deleted; the history below is kept as the record
          of their stay.
        </p>
      )}

      {/* filters */}
      <div className="flex flex-col items-stretch justify-between gap-space-md rounded-xl bg-surface-container-low p-space-sm lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-space-xs">
          <span className="px-2 font-code-sm text-code-sm uppercase text-outline">Range:</span>
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-lg px-space-md py-1.5 font-label-caps text-label-caps uppercase tracking-wider transition-colors ${
                range === r.key
                  ? 'bg-primary font-semibold text-on-primary shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              {r.label()}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-space-xs rounded-lg bg-surface-container p-1">
          {[
            ['all', `All Events (${counts.all})`],
            ['in', `Entries (${counts.in})`],
            ['out', `Exits (${counts.out})`],
            ['manual', `Manual (${counts.manual})`],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
              className={`rounded px-space-sm py-1 font-code-sm text-code-sm transition-colors ${
                kind === key
                  ? 'bg-surface-container-high font-semibold text-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-space-lg lg:grid-cols-12">
        {/* timeline */}
        <div className="flex flex-col gap-space-md lg:col-span-8">
          <div className="flex items-center justify-between rounded-lg bg-surface-container-lowest px-space-md py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
              <Caps className="font-semibold tracking-wider text-on-surface">Movement history</Caps>
            </div>
            <span className="font-code-sm text-code-sm text-outline">Newest first</span>
          </div>

          {shown.length === 0 ? (
            <Empty>
              {logs.length === 0
                ? 'No movements recorded yet.'
                : 'No movements match this range and filter.'}
            </Empty>
          ) : (
            <ol className="relative space-y-8 pl-6 before:absolute before:inset-y-0 before:left-3 before:w-0.5 before:bg-surface-variant sm:pl-8 sm:before:left-4">
              {shown.map((log) => {
                const o = log.direction === 'out';
                const manual = log.source === 'manual';
                const gap = away.get(log.id);
                const tag = manual
                  ? { text: 'Manual override', cls: 'bg-surface-container-highest text-on-surface-variant' }
                  : log.flagged
                    ? { text: 'Repeat direction', cls: 'bg-tertiary/15 text-tertiary' }
                    : o
                      ? { text: 'Exit', cls: 'bg-tertiary/15 text-tertiary' }
                      : { text: 'Entry', cls: 'bg-secondary/15 text-secondary' };
                return (
                  <li key={log.id} className="relative flex flex-col gap-2">
                    <div
                      className={`absolute -left-6 top-1.5 flex h-6 w-6 items-center justify-center rounded-full shadow-md ring-4 ring-surface sm:-left-8 ${
                        manual ? 'bg-surface-container-highest text-tertiary' : o ? 'bg-tertiary-container text-on-tertiary' : 'bg-secondary-container text-on-secondary'
                      }`}
                    >
                      <Icon name={manual ? 'lock_open' : o ? 'logout' : 'login'} className="text-sm" />
                    </div>
                    <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-center">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-headline-md text-headline-md font-semibold">
                          {o ? 'Exited PG gate' : 'Entered PG gate'}
                        </span>
                        <span className={`rounded px-2 py-0.5 font-code-sm text-code-sm font-semibold uppercase ${tag.cls}`}>
                          {tag.text}
                        </span>
                      </div>
                      <time dateTime={log.timestamp} className="font-code-tabular text-code-tabular text-on-surface-variant">
                        {dayWord(log.timestamp)} • {clockTimeUpper(log.timestamp)}
                      </time>
                    </div>

                    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-container p-space-md shadow-sm">
                      {manual ? (
                        <>
                          <span className="font-body-md text-body-md font-semibold">Entered by hand at the desk</span>
                          {log.note && (
                            <p className="rounded bg-surface-container-lowest px-space-sm py-1.5 font-body-sm text-body-sm text-on-surface">
                              <span className="font-semibold text-tertiary">Reason recorded: </span>
                              {log.note}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-body-md text-body-md font-semibold">Entrance camera</span>
                            {log.confidence != null && (
                              <span className="rounded bg-surface-container-high px-1.5 py-0.5 font-code-sm text-code-sm text-primary">
                                match {scoreText(log.confidence)}
                              </span>
                            )}
                          </div>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {log.inferred
                              ? 'Camera couldn’t read the walking direction, so the register toggled the guest’s last state.'
                              : 'Camera read the walking direction from the face moving toward or away from it.'}
                          </span>
                          {log.flagged && log.note && (
                            <span className="font-body-sm text-body-sm text-tertiary">{log.note}</span>
                          )}
                        </>
                      )}
                      {gap != null && (
                        <span className="flex items-center gap-1 font-code-sm text-code-sm text-on-surface">
                          <Icon name="timer" className="text-xs text-primary" /> Away for {formatDuration(gap)}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* side panel: what we actually hold on this guest */}
        <div className="flex flex-col gap-space-lg lg:col-span-4">
          <div className="flex flex-col gap-space-md rounded-xl bg-surface-container p-space-lg shadow-lg">
            <div className="flex items-center gap-2">
              <Icon name="fingerprint" className="text-primary" />
              <h3 className="font-headline-md text-headline-md">Face enrollment</h3>
            </div>
            <dl className="flex flex-col gap-space-sm font-code-tabular text-code-tabular">
              <div className="flex justify-between gap-2">
                <dt className="text-outline">PHOTOS USED</dt>
                <dd>{guest.photo_count || '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-outline">ENROLLED</dt>
                <dd>{guest.enrolled_at ? new Date(guest.enrolled_at).toLocaleDateString('en-IN') : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-outline">CAMERA READS</dt>
                <dd>{stats.cameraReads}</dd>
              </div>
            </dl>
            <p className="rounded-lg bg-surface-container-lowest p-space-sm font-body-sm text-body-sm text-on-surface-variant">
              The photos were deleted as soon as the face had been learned. Only the face measurements are
              kept, on this machine, and they are removed when the guest moves out.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
