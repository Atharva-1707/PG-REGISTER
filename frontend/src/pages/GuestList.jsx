import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGuests, removeGuests, timeAgo } from '../api';
import { useOverride } from '../components/OverrideContext';
import { Avatar, Empty, ErrorState, Icon, Loading, StatusPill } from '../components/StatusBits';

const LONG_PRESS_MS = 450;

/** The tick box on the left of a row while choosing. */
function Tick({ on }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        on ? 'border-primary bg-primary text-on-primary' : 'border-outline bg-transparent'
      }`}
    >
      {on && <Icon name="check" className="text-base font-bold" />}
    </span>
  );
}

/** What a row says about a guest. Shared by the link and the choosable version. */
function RowBody({ guest, leading }) {
  return (
    <>
      {leading}
      <Avatar name={guest.name} tone={guest.status === 'out' ? 'out' : 'in'} />
      <span className="w-14 shrink-0 font-code-tabular text-code-tabular text-on-surface-variant">
        {guest.room_no}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-body-md text-body-md font-semibold">{guest.name}</span>
        <span className="mt-0.5 block font-code-sm text-code-sm text-outline">
          Last seen {timeAgo(guest.last_seen)}
          {guest.movements_today > 0 && ` · ${guest.movements_today} today`}
        </span>
      </span>
      <StatusPill status={guest.status} presumed={guest.presumed} />
    </>
  );
}

/** "Asha, Rohit and 3 others" — the confirmation names who is going. */
function nameList(guests) {
  const names = guests.map((g) => g.name);
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} others`;
}

function ConfirmRemove({ guests, busy, error, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  const many = guests.length > 1;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-title"
        className="w-full max-w-md rounded-2xl bg-surface-container-high p-space-lg shadow-2xl"
      >
        <h2 id="remove-title" className="font-headline-md text-headline-md">
          Remove {many ? `${guests.length} guests` : guests[0].name}?
        </h2>
        {many && (
          <p className="mt-2 font-body-md text-body-md text-on-surface">{nameList(guests)}</p>
        )}
        <p className="mt-2 font-body-md text-body-md text-on-surface-variant">
          The camera will stop recognising {many ? 'them' : 'this guest'} and their face data is
          deleted from this machine. They come off the guest list, but past movements stay in the
          register. Adding them back later means enrolling again with new photos.
        </p>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-tertiary/10 px-3 py-2 font-body-md text-body-md text-tertiary">
            {error}
          </p>
        )}

        <div className="mt-space-lg flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg bg-surface-container-highest px-4 py-2.5 font-body-md text-body-md font-medium text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-error-container px-4 py-2.5 font-body-md text-body-md font-semibold text-on-error-container transition-colors hover:brightness-110 disabled:opacity-60"
          >
            {busy && (
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-on-error-container/40 border-t-on-error-container"
                aria-hidden="true"
              />
            )}
            {busy ? 'Removing…' : many ? `Remove ${guests.length} guests` : 'Remove guest'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * All enrolled guests, their current state and when they were last seen.
 *
 * Choosing works like a phone gallery: press and hold a guest, or tap Select,
 * then tap to add or drop others. A bar at the top shows how many are chosen
 * and offers Select all and Remove.
 */
export default function GuestList() {
  const { tick } = useOverride();
  const [guests, setGuests] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Held-press bookkeeping. A ref, not state: none of it should re-render.
  const pressTimer = useRef(null);
  const justLongPressed = useRef(false);
  const enteredByHold = useRef(false);

  const load = useCallback(() => {
    setError(null);
    return getGuests()
      .then(setGuests)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load, tick]);

  // Someone removed from another screen while chosen here: drop them quietly.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const live = new Set(guests.filter((g) => g.active).map((g) => g.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [guests]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guests
      .filter((g) => g.active)
      .filter((g) => filter === 'all' || g.status === filter)
      .filter((g) => !q || g.name.toLowerCase().includes(q) || g.room_no.includes(q));
  }, [guests, filter, query]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setConfirming(false);
    setRemoveError(null);
    enteredByHold.current = false;
  }, []);

  // Escape backs out of choosing, like the back arrow in a gallery.
  useEffect(() => {
    if (!selecting || confirming) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') exitSelecting();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, confirming, exitSelecting]);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    // Like a gallery: dropping the last tick ends a hold-started selection.
    if (next.size === 0 && enteredByHold.current) exitSelecting();
  };

  const startHold = (id) => {
    if (selecting) return;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      justLongPressed.current = true;
      enteredByHold.current = true;
      setSelecting(true);
      setSelected(new Set([id]));
      if (navigator.vibrate) navigator.vibrate(15);
    }, LONG_PRESS_MS);
  };
  const cancelHold = () => clearTimeout(pressTimer.current);

  const onLinkClick = (event) => {
    // The click that ends a long press would otherwise open the guest's page.
    if (justLongPressed.current) {
      justLongPressed.current = false;
      event.preventDefault();
    }
  };

  const allVisibleChosen = visible.length > 0 && visible.every((g) => selected.has(g.id));
  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleChosen) visible.forEach((g) => next.delete(g.id));
      else visible.forEach((g) => next.add(g.id));
      return next;
    });
  };

  const chosen = guests.filter((g) => g.active && selected.has(g.id));

  const confirmRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await removeGuests(chosen.map((g) => g.id));
      const gone = result.removed.length;
      await load();
      exitSelecting();
      setNotice(
        gone === 0
          ? 'Those guests were already removed.'
          : `Removed ${gone} ${gone === 1 ? 'guest' : 'guests'}. The camera stops matching them within a few seconds.`
      );
    } catch (e) {
      // Stay on the dialog with the selection intact so they can try again.
      setRemoveError(e.message);
    } finally {
      setRemoving(false);
    }
  };

  if (loading) return <div className="p-gutter"><Loading label="Loading guests…" /></div>;
  if (error && guests.length === 0) {
    return <div className="p-gutter"><ErrorState message={error} onRetry={load} /></div>;
  }

  const active = guests.filter((g) => g.active);
  const counts = {
    all: active.length,
    in: active.filter((g) => g.status === 'in').length,
    out: active.filter((g) => g.status === 'out').length,
  };

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      {selecting ? (
        <header className="sticky top-0 z-30 -mx-gutter-mobile flex flex-wrap items-center gap-2 bg-surface-container-high px-gutter-mobile py-3 shadow-lg md:-mx-gutter md:px-gutter">
          <button
            type="button"
            onClick={exitSelecting}
            aria-label="Cancel selection"
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface transition-colors hover:bg-surface-container-highest"
          >
            <Icon name="close" className="text-2xl" />
          </button>
          <p className="font-headline-md text-headline-md" aria-live="polite">
            {selected.size === 0 ? 'Select guests' : `${selected.size} selected`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAll}
              disabled={visible.length === 0}
              className="rounded-lg px-3 py-2 font-body-md text-body-md font-medium text-primary transition-colors hover:bg-surface-container-highest disabled:opacity-40"
            >
              {allVisibleChosen ? 'Clear' : 'Select all'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRemoveError(null);
                setConfirming(true);
              }}
              disabled={selected.size === 0}
              className="flex items-center gap-2 rounded-lg bg-error-container px-4 py-2 font-body-md text-body-md font-semibold text-on-error-container transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="delete" className="text-xl" /> Remove
            </button>
          </div>
        </header>
      ) : (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg">Guest List</h1>
            <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
              {counts.all} enrolled · tap a name for their full history
            </p>
          </div>
          <div className="flex items-center gap-2">
            {counts.all > 0 && (
              <button
                type="button"
                onClick={() => setSelecting(true)}
                className="flex items-center gap-2 rounded-lg bg-surface-container-high px-4 py-2.5 font-body-md text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
              >
                <Icon name="checklist" className="text-xl" /> Select
              </button>
            )}
            <Link
              to="/outpass"
              className="flex items-center gap-2 rounded-lg bg-surface-container-high px-4 py-2.5 font-body-md text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
            >
              <Icon name="badge" className="text-xl" /> Outpass
            </Link>
            <Link
              to="/add"
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-body-md text-body-md font-semibold text-on-primary transition-colors hover:bg-primary-fixed"
            >
              <Icon name="person_add" className="text-xl" /> Add a guest
            </Link>
          </div>
        </header>
      )}

      {error && guests.length > 0 && (
        <p role="alert" className="rounded-xl bg-tertiary/10 px-4 py-3 font-body-md text-body-md text-tertiary">
          Couldn&rsquo;t refresh the list: {error}. Showing what was loaded last.
        </p>
      )}

      {notice && (
        <p role="status" className="rounded-xl bg-secondary/10 px-4 py-3 font-body-md text-body-md text-secondary">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {[
          ['all', 'Everyone'],
          ['in', 'In'],
          ['out', 'Out'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1.5 font-body-md text-body-md transition-colors ${
              filter === key
                ? 'bg-primary-container font-semibold text-on-primary'
                : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            }`}
          >
            {label} ({counts[key]})
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-56">
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-on-surface-variant" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or room"
            aria-label="Search guests"
            className="w-full rounded bg-surface-container py-2 pl-8 pr-3 font-body-md text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <Empty>
          {guests.length === 0
            ? 'No one is enrolled yet. Use Add a guest to enroll the first person.'
            : 'No guests match that filter.'}
        </Empty>
      ) : (
        <ul className="divide-y divide-surface-container-high/50 overflow-hidden rounded-xl bg-surface-container shadow-lg">
          {visible.map((guest) => {
            const on = selected.has(guest.id);
            return (
              <li key={guest.id}>
                {selecting ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(guest.id)}
                    className={`flex w-full select-none items-center gap-3 px-space-md py-3 text-left transition-colors ${
                      on ? 'bg-primary/10' : 'hover:bg-surface-container-high/60'
                    }`}
                  >
                    <RowBody guest={guest} leading={<Tick on={on} />} />
                  </button>
                ) : (
                  <Link
                    to={`/guests/${guest.id}`}
                    onClick={onLinkClick}
                    onPointerDown={() => startHold(guest.id)}
                    onPointerUp={cancelHold}
                    onPointerLeave={cancelHold}
                    onPointerCancel={cancelHold}
                    onContextMenu={(e) => {
                      // A long press on a phone opens the browser's link menu;
                      // here it means "start choosing".
                      if (justLongPressed.current) e.preventDefault();
                    }}
                    draggable={false}
                    className="flex select-none items-center gap-3 px-space-md py-3 transition-colors hover:bg-surface-container-high/60"
                  >
                    <RowBody guest={guest} />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirming && chosen.length > 0 && (
        <ConfirmRemove
          guests={chosen}
          busy={removing}
          error={removeError}
          onCancel={() => setConfirming(false)}
          onConfirm={confirmRemove}
        />
      )}
    </div>
  );
}
