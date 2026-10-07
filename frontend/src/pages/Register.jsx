import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clockTimeUpper,
  dayWord,
  formatDuration,
  getGuest,
  getGuests,
  getLogs,
  getSummary,
  awayDurations,
} from '../api';
import { useOverride } from '../components/OverrideContext';
import {
  Avatar,
  Caps,
  Empty,
  ErrorState,
  Icon,
  Loading,
  MethodBadge,
  StatusPill,
} from '../components/StatusBits';

/**
 * The page that replaces the paper register: who is where right now, and
 * every movement recorded today, newest first.
 *
 * From the GateLog "main dashboard" design. What's real here: the three
 * counts, the roster table, the latest-movements feed and the guest drawer.
 * What was in the mockup and isn't here, because nothing backs it: "/ 20 Max"
 * capacity, curfew countdown, average outing, overdue alerts, floor names,
 * the inference-latency strip, "Buzz Door Release", an emergency lock, and a
 * guardian phone number. The live camera tile is a link to the At the Door
 * page rather than a second poller — polling is what keeps the camera
 * encoding frames, and it should only happen where someone is looking.
 */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'In PG' },
  { key: 'out', label: 'Outside' },
];

function Kpi({ tone, label, badge, value, caption, icon, foot }) {
  const text = { neutral: 'text-on-surface', in: 'text-secondary', out: 'text-tertiary' }[tone];
  const wash = { neutral: 'bg-primary/5', in: 'bg-secondary/10', out: 'bg-tertiary/10' }[tone];
  const chip = { neutral: 'bg-surface-container-high text-primary', in: 'bg-secondary/15 text-secondary', out: 'bg-tertiary/15 text-tertiary' }[tone];
  return (
    <div className="relative flex flex-col justify-between overflow-hidden rounded-xl bg-surface-container p-space-sm shadow-md md:p-space-lg">
      <div className="flex items-start justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className={`font-label-caps text-[10px] uppercase tracking-wide md:text-label-caps md:tracking-widest ${tone === 'neutral' ? 'text-on-surface-variant' : text}`}>
              {label}
            </span>
            {badge && (
              <span className={`hidden rounded-full px-2 py-0.5 font-code-sm text-code-sm font-semibold md:inline ${chip}`}>
                {badge}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-space-sm">
            <span className={`font-headline-lg text-headline-lg font-bold tabular-nums md:font-display-lg md:text-display-lg ${text}`}>{value}</span>
            <span className="hidden font-body-md text-body-md text-on-surface-variant md:inline">{caption}</span>
          </div>
        </div>
        <div className={`hidden h-11 w-11 items-center justify-center rounded-lg md:flex ${chip}`}>
          <Icon name={icon} className="text-2xl" />
        </div>
      </div>
      <p className="mt-space-md hidden font-code-sm text-code-sm text-on-surface-variant md:block">{foot}</p>
      <div className={`pointer-events-none absolute -bottom-6 -right-6 h-28 w-28 rounded-full blur-2xl ${wash}`} />
    </div>
  );
}

/** Slide-out with one guest's movements since the register last rolled over. */
function GuestDrawer({ guestId, dayStart, onClose }) {
  const { open: openOverride, tick } = useOverride();
  const [guest, setGuest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    getGuest(guestId)
      .then((g) => alive && setGuest(g))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [guestId, tick]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const today = useMemo(() => {
    if (!guest) return [];
    const from = dayStart ? new Date(dayStart) : new Date(0);
    return guest.logs.filter((l) => new Date(l.timestamp) >= from);
  }, [guest, dayStart]);
  const away = useMemo(() => (guest ? awayDurations(guest.logs) : new Map()), [guest]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-surface-container-lowest/60" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-surface-container-low shadow-2xl"
        role="dialog"
        aria-label="Guest timeline"
      >
        <div className="flex items-center justify-between bg-surface-container p-space-md">
          <div className="flex items-center gap-2">
            <Icon name="person_pin" className="text-primary" />
            <h2 className="font-headline-md text-headline-md text-lg">Guest Timeline</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-space-lg overflow-y-auto p-space-lg">
          {error && <ErrorState message={error} />}
          {!guest && !error && <Loading />}
          {guest && (
            <>
              <div className="flex items-center gap-space-md rounded-xl bg-surface-container p-space-md">
                <Avatar name={guest.name} size="lg" tone={guest.status === 'out' ? 'out' : 'in'} />
                <div className="flex min-w-0 flex-col">
                  <h3 className="truncate font-headline-md text-headline-md font-bold">{guest.name}</h3>
                  <span className="font-code-tabular text-code-tabular text-on-surface-variant">
                    Room {guest.room_no}
                    {guest.phone && ` · ${guest.phone}`}
                  </span>
                  <div className="mt-1">
                    <StatusPill status={guest.status} presumed={guest.presumed} />
                  </div>
                </div>
              </div>

              <div className="flex flex-col">
                <Caps className="mb-space-sm tracking-wider">Since the register rolled over</Caps>
                {today.length === 0 ? (
                  <Empty>Nothing recorded since {dayStart ? clockTimeUpper(dayStart) : '4 AM'}.</Empty>
                ) : (
                  <ol className="relative space-y-space-md pl-6 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-0.5 before:bg-surface-container-highest">
                    {today.map((log) => {
                      const out = log.direction === 'out';
                      const gap = away.get(log.id);
                      return (
                        <li key={log.id} className="relative">
                          <span className={`absolute -left-6 top-1 h-2.5 w-2.5 rounded-full ring-4 ring-surface-container-low ${out ? 'bg-tertiary' : 'bg-secondary'}`} />
                          <div className="rounded bg-surface-container p-space-sm">
                            <div className="flex items-center justify-between">
                              <span className={`font-body-md text-body-md font-semibold ${out ? 'text-tertiary' : 'text-secondary'}`}>
                                {out ? 'Exited' : 'Entered'}
                              </span>
                              <span className="font-code-sm text-code-sm text-on-surface-variant">
                                {clockTimeUpper(log.timestamp)}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                              <MethodBadge log={log} />
                              {log.inferred && log.source === 'camera' && (
                                <span className="font-code-sm text-code-sm text-outline">direction assumed</span>
                              )}
                              {gap != null && (
                                <span className="font-code-sm text-code-sm text-outline">
                                  away {formatDuration(gap)}
                                </span>
                              )}
                            </div>
                            {log.note && (
                              <p className={`mt-1 font-body-sm text-body-sm ${log.flagged ? 'text-tertiary' : 'text-on-surface-variant'}`}>
                                {log.note}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              <div className="mt-auto flex flex-col gap-space-sm">
                <button
                  type="button"
                  onClick={() => openOverride({ guestId: guest.id })}
                  className="flex items-center justify-center gap-2 rounded bg-primary px-space-md py-2.5 font-label-caps text-label-caps uppercase tracking-wider text-on-primary transition-colors hover:bg-primary-fixed"
                >
                  <Icon name="how_to_reg" className="text-base" /> Log manual entry
                </button>
                <Link
                  to={`/guests/${guest.id}`}
                  className="flex items-center justify-center gap-2 rounded bg-surface-container-high px-space-md py-2.5 font-label-caps text-label-caps uppercase tracking-wider text-on-surface transition-colors hover:text-primary"
                >
                  <Icon name="history" className="text-base" /> Full history
                </Link>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default function Register() {
  const { tick } = useOverride();
  const [summary, setSummary] = useState(null);
  const [guests, setGuests] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [drawerId, setDrawerId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return Promise.all([getSummary(), getGuests(), getLogs({ limit: 300 })])
      .then(([s, g, l]) => {
        setSummary(s);
        setGuests(g.filter((x) => x.active));
        setLogs(l);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // the door doesn't wait for a refresh
    return () => clearInterval(t);
  }, [load, tick]);

  /** Each guest's most recent logged movement, for the method column. */
  const lastLog = useMemo(() => {
    const map = new Map();
    for (const log of logs) if (!map.has(log.guest_id)) map.set(log.guest_id, log); // newest first
    return map;
  }, [logs]);

  const counts = useMemo(
    () => ({
      all: guests.length,
      in: guests.filter((g) => g.status === 'in').length,
      out: guests.filter((g) => g.status === 'out').length,
    }),
    [guests]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guests
      .filter((g) => filter === 'all' || g.status === filter)
      .filter((g) => !q || g.name.toLowerCase().includes(q) || g.room_no.toLowerCase().includes(q));
  }, [guests, filter, query]);

  const dayStart = summary?.day_started ? new Date(summary.day_started) : null;
  const sinceStart = useMemo(
    () => logs.filter((l) => !dayStart || new Date(l.timestamp) >= dayStart),
    [logs, dayStart]
  );
  const pct = (n) => (counts.all ? Math.round((n / counts.all) * 100) : 0);

  if (loading) return <div className="p-gutter"><Loading label="Reading the register…" /></div>;
  if (error && !summary) return <div className="p-gutter"><ErrorState message={error} onRetry={load} /></div>;

  return (
    <div className="flex flex-col gap-space-md px-gutter-mobile py-space-md md:px-gutter">
      {error && (
        <p className="rounded-lg bg-tertiary/10 px-space-md py-space-sm font-body-md text-body-md text-tertiary" role="alert">
          Couldn&rsquo;t refresh just now ({error}). Showing the last reading.
        </p>
      )}

      <section className="grid grid-cols-3 gap-gutter-mobile md:gap-gutter">
        <Kpi
          tone="neutral"
          label="Registered Guests"
          value={summary.total_guests}
          caption="enrolled"
          icon="apartment"
          foot={dayStart ? `Counting from ${clockTimeUpper(dayStart.toISOString())} · ${dayWord(dayStart.toISOString())}` : ''}
        />
        <Kpi
          tone="in"
          label="Currently Inside"
          badge={`${pct(summary.currently_in)}% on premises`}
          value={summary.currently_in}
          caption="in the PG"
          icon="meeting_room"
          foot={
            summary.unconfirmed > 0
              ? `${summary.unconfirmed} of ${summary.total_guests} not seen since the 4am rollover — counted as in`
              : 'Every guest confirmed since the 4am rollover'
          }
        />
        <Kpi
          tone="out"
          label="Currently Away"
          badge={`${pct(summary.currently_out)}% out`}
          value={summary.currently_out}
          caption="outside"
          icon="directions_walk"
          foot={`${summary.movements_today} movement${summary.movements_today === 1 ? '' : 's'} recorded today`}
        />
      </section>

      {summary.unconfirmed > 0 && (
        <p className="font-code-sm text-code-sm text-on-surface-variant md:hidden">
          {summary.unconfirmed} of {summary.total_guests} not seen since the 4am rollover — counted as in.
        </p>
      )}

      <section className="grid grid-cols-1 items-start gap-gutter xl:grid-cols-12">
        {/* roster */}
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface-container shadow-lg xl:col-span-8">
          <div className="flex flex-col items-stretch justify-between gap-space-sm bg-surface-container-high p-space-md lg:flex-row lg:items-center">
            <div className="flex flex-wrap items-center gap-space-xs">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={`rounded-md px-space-md py-1.5 font-body-sm text-body-sm transition-all ${
                    filter === f.key
                      ? 'bg-primary-container font-semibold text-on-primary'
                      : 'bg-surface-container-lowest font-medium text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {f.label} ({counts[f.key]})
                </button>
              ))}
            </div>
            <div className="flex flex-1 items-center gap-space-sm lg:max-w-xs">
              <div className="relative w-full">
                <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-on-surface-variant" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or room #…"
                  aria-label="Search guests"
                  className="w-full rounded bg-surface-container-lowest py-1.5 pl-8 pr-space-sm font-body-sm text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="flex shrink-0 items-center gap-1.5 rounded bg-surface-container-lowest px-space-sm py-1.5 font-code-sm text-code-sm text-secondary">
                <span className="h-2 w-2 animate-pulse rounded-full bg-secondary" />
                <span className="hidden sm:inline">Auto-sync 5s</span>
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="p-space-md">
              <Empty>
                {guests.length === 0
                  ? 'No one is enrolled yet. Use Add a Guest to enroll the first person.'
                  : 'No guests match that filter.'}
              </Empty>
            </div>
          ) : (
            <div className="hidden w-full overflow-x-auto md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-surface-container-low font-label-caps text-label-caps uppercase text-on-surface-variant">
                    <th className="px-space-md py-3">Guest &amp; Room</th>
                    <th className="px-space-md py-3">State</th>
                    <th className="px-space-md py-3">Last Activity</th>
                    <th className="px-space-md py-3">Logged</th>
                    <th className="px-space-md py-3">Method</th>
                    <th className="px-space-md py-3 text-right">Audit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-high/40 font-body-sm text-body-sm">
                  {rows.map((g) => {
                    const last = lastLog.get(g.id);
                    const same = last && last.timestamp === g.last_seen ? last : null;
                    const lastOut = g.last_direction === 'out';
                    return (
                      <tr key={g.id} className="transition-colors hover:bg-surface-container-high/50">
                        <td className="px-space-md py-3">
                          <div className="flex items-center gap-space-sm">
                            <Avatar name={g.name} tone={g.status === 'out' ? 'out' : 'in'} />
                            <div className="flex flex-col">
                              <span className="text-[15px] font-semibold leading-none text-on-surface">{g.name}</span>
                              <span className="mt-0.5 font-code-tabular text-xs text-on-surface-variant">
                                Room {g.room_no}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="px-space-md py-3">
                          <StatusPill status={g.status} presumed={g.presumed} />
                        </td>
                        <td className="px-space-md py-3">
                          {g.last_direction ? (
                            <span className={`inline-flex items-center gap-1 font-medium ${lastOut ? 'text-tertiary' : 'text-secondary'}`}>
                              <Icon name={lastOut ? 'logout' : 'login'} className="text-sm" />
                              {lastOut ? 'Exited' : 'Entered'}
                            </span>
                          ) : (
                            <span className="text-outline">Not seen yet</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-space-md py-3 font-code-tabular text-on-surface">
                          {g.last_seen ? `${clockTimeUpper(g.last_seen)} ${dayWord(g.last_seen)}` : '—'}
                        </td>
                        <td className="px-space-md py-3">
                          <MethodBadge log={same} />
                        </td>
                        <td className="px-space-md py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setDrawerId(g.id)}
                            className="font-code-sm text-code-sm text-primary hover:text-primary-fixed hover:underline"
                          >
                            Timeline →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && (
            <ul className="divide-y divide-surface-container-high/40 md:hidden">
              {rows.map((g) => {
                const last = lastLog.get(g.id);
                const same = last && last.timestamp === g.last_seen ? last : null;
                const lastOut = g.last_direction === 'out';
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => setDrawerId(g.id)}
                      className="flex w-full items-center gap-space-sm px-space-md py-3 text-left transition-colors active:bg-surface-container-high/60"
                    >
                      <Avatar name={g.name} tone={g.status === 'out' ? 'out' : 'in'} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-body-md text-body-md font-semibold">{g.name}</span>
                        <span className="font-code-sm text-code-sm text-on-surface-variant">
                          Rm {g.room_no}
                          {g.last_seen
                            ? ` · ${lastOut ? 'exited' : 'entered'} ${clockTimeUpper(g.last_seen)}${dayWord(g.last_seen) === 'Today' ? '' : ` ${dayWord(g.last_seen)}`}`
                            : ' · not seen yet'}
                        </span>
                        {same && (
                          <span className="mt-1">
                            <MethodBadge log={same} />
                          </span>
                        )}
                      </span>
                      <StatusPill status={g.status} presumed={g.presumed} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center justify-between bg-surface-container-lowest px-space-md py-2 font-code-sm text-code-sm text-on-surface-variant">
            <span>
              Showing {rows.length} of {counts.all} enrolled
            </span>
            <span className="hidden items-center gap-1.5 text-secondary sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-secondary" /> Face data stored on this machine only
            </span>
          </div>
        </div>

        {/* right column */}
        <div className="flex flex-col gap-gutter xl:col-span-4">
          <Link
            to="/camera"
            className="group relative flex flex-col overflow-hidden rounded-xl bg-surface-container shadow-lg"
          >
            <div className="flex items-center justify-between bg-surface-container-high px-space-md py-space-sm">
              <span className="font-label-caps text-label-caps font-bold uppercase tracking-wider">Entrance camera</span>
              <span className="font-code-sm text-code-sm text-primary">Live view →</span>
            </div>
            <div className="reticle relative flex aspect-video items-center justify-center bg-surface-container-lowest px-space-lg text-center">
              <div>
                <Icon name="videocam" className="text-3xl text-primary" />
                <p className="mt-1 font-body-md text-body-md text-on-surface">Open the live door view</p>
                <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                  The picture only runs while someone is watching it, to spare the mini PC.
                </p>
              </div>
            </div>
          </Link>

          <div className="flex flex-col rounded-xl bg-surface-container p-space-md shadow-lg">
            <div className="mb-space-md flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="radar" className="text-lg text-primary" />
                <h3 className="font-headline-md text-headline-md text-base">Latest Movements</h3>
              </div>
              <span className="font-code-sm text-code-sm font-medium text-on-surface-variant">Since 4 AM</span>
            </div>

            {sinceStart.length === 0 ? (
              <Empty>
                Nothing recorded yet. Movements appear here within a few seconds of someone passing the
                entrance camera.
              </Empty>
            ) : (
              <ul className="flex flex-col gap-space-sm">
                {sinceStart.slice(0, 8).map((log) => {
                  const out = log.direction === 'out';
                  const manual = log.source === 'manual';
                  return (
                    <li
                      key={log.id}
                      className="flex items-start justify-between gap-space-sm rounded-lg bg-surface-container-low p-space-sm transition-colors hover:bg-surface-container-high"
                    >
                      <div className="flex min-w-0 items-start gap-space-sm">
                        <div
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                            manual ? 'bg-surface-container-highest text-tertiary' : out ? 'bg-tertiary/15 text-tertiary' : 'bg-secondary/15 text-secondary'
                          }`}
                        >
                          <Icon name={manual ? 'lock_open' : out ? 'logout' : 'login'} className="text-sm" />
                        </div>
                        <div className="flex min-w-0 flex-col">
                          <div className="flex items-center gap-1.5">
                            <Link to={`/guests/${log.guest_id}`} className="truncate font-body-md text-body-md font-semibold hover:underline">
                              {log.guest_name}
                            </Link>
                            <span className="shrink-0 font-code-sm text-code-sm text-on-surface-variant">Rm {log.room_no}</span>
                          </div>
                          <span className={`font-code-sm text-code-sm ${out ? 'text-tertiary' : 'text-secondary'}`}>
                            {out ? 'Exited' : 'Entered'}
                            {manual
                              ? ' · manual entry'
                              : log.confidence != null
                                ? ` · match ${log.confidence.toFixed(2)}`
                                : ''}
                            {log.inferred && !manual && ' · direction assumed'}
                          </span>
                          {log.flagged && <span className="font-body-sm text-body-sm text-tertiary">{log.note}</span>}
                        </div>
                      </div>
                      <time className="shrink-0 font-code-tabular text-xs text-on-surface-variant" dateTime={log.timestamp}>
                        {clockTimeUpper(log.timestamp)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {drawerId && (
        <GuestDrawer
          guestId={drawerId}
          dayStart={summary?.day_started}
          onClose={() => setDrawerId(null)}
        />
      )}
    </div>
  );
}
