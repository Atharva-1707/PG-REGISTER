import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { getSummary } from '../api';
import { Icon } from './StatusBits';
import { OverrideProvider, useOverride } from './OverrideContext';

/**
 * Shell for the register, from the GateLog design: a fixed top bar with the
 * nav on wide screens, and a bottom bar on phones and tablets — the manager
 * checks this at the door, not at a desk.
 *
 * Not carried over from the mockup because nothing real backs them: the
 * "CAM-01: ONLINE (30 FPS)" pill, the "v2.4-SEC" version tag, the warden's
 * name and shift. The health pill instead reports what the browser can
 * actually know — whether the register API is answering.
 */

/**
 * The phone bar carries only what gets done at the door: register, camera,
 * guests and outpass, plus Override. It also stands in for the top menu on any
 * window narrower than 1280px, which is why Outpass must be on it.
 * "Add a guest" is reached from the guest list, and tuning is a sit-down job,
 * so "Unknown faces" stays on the wide-screen nav.
 */
const NAV = [
  { to: '/', label: 'Live Dashboard', short: 'Register', icon: 'dashboard', end: true, phone: true },
  { to: '/camera', label: 'At the Door', short: 'Door', icon: 'videocam', phone: true },
  { to: '/guests', label: 'Guest List', short: 'Guests', icon: 'groups', phone: true },
  { to: '/outpass', label: 'Outpass', short: 'Outpass', icon: 'badge', phone: true },
  { to: '/add', label: 'Add a Guest', short: 'Add', icon: 'person_add', phone: false },
  { to: '/unknown', label: 'Unknown Faces', short: 'Unknown', icon: 'face_retouching_off', phone: false },
];

function topNavClass({ isActive }) {
  return [
    'flex h-full items-center border-b-2 px-space-md font-body-md text-body-md transition-colors',
    isActive
      ? 'border-primary bg-surface-container-high font-semibold text-primary'
      : 'border-transparent text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
  ].join(' ');
}

/** Emerald when the API answered recently, amber when it didn't. */
function ServiceHealth() {
  const [online, setOnline] = useState(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      getSummary()
        .then(() => alive && setOnline(true))
        .catch(() => alive && setOnline(false));
    check();
    const t = setInterval(check, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (online === null) return null;
  const dot = online ? 'bg-secondary' : 'bg-tertiary';
  return (
    <div
      className="hidden items-center gap-2 rounded-full border border-surface-variant bg-surface-container-low px-space-sm py-1.5 md:flex"
      role="status"
    >
      <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
        {online && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dot} opacity-75`} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
      </span>
      <span className="font-code-sm text-code-sm text-on-surface">
        {online ? 'REGISTER ONLINE' : 'REGISTER UNREACHABLE'}
      </span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hidden items-center gap-1.5 rounded border border-surface-variant bg-surface-container-low px-space-sm py-1.5 font-code-tabular text-code-tabular text-on-surface-variant lg:flex">
      <Icon name="schedule" className="text-sm text-primary" />
      <span>{now.toLocaleTimeString('en-IN', { hour12: false })} · Today</span>
    </div>
  );
}

function OverrideButton({ compact = false }) {
  const { open } = useOverride();
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => open()}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 font-label-caps text-label-caps text-tertiary"
      >
        <Icon name="lock_open" className="text-xl" />
        Override
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => open()}
      className="flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container-high px-space-md py-1.5 font-label-caps text-label-caps text-tertiary transition-all hover:border-tertiary hover:bg-surface-container-highest"
    >
      <Icon name="lock_open" className="text-base" />
      <span className="hidden sm:inline">+ Manual Override</span>
      <span className="sm:hidden">Override</span>
    </button>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="fixed top-0 z-50 w-full border-b border-surface-variant bg-surface-container-lowest/95 backdrop-blur-xl">
        <div className="flex h-16 w-full items-center justify-between gap-space-md px-gutter-mobile md:px-gutter">
          <div className="flex shrink-0 items-center gap-space-md">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon name="frame_person" fill className="text-2xl" />
            </div>
            <div className="flex flex-col">
              <span className="font-headline-md text-headline-md leading-tight tracking-tight">GateLog</span>
              <span className="font-code-sm text-code-sm text-on-surface-variant">Sai Residency PG</span>
            </div>
          </div>

          <nav className="hidden h-full items-center gap-space-xs xl:flex" aria-label="Main">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={topNavClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-space-md">
            <ServiceHealth />
            <Clock />
            <OverrideButton />
          </div>
        </div>
      </header>

      <main className="w-full pb-24 pt-16 xl:pb-0">{children}</main>

      <footer className="hidden border-t border-surface-variant bg-surface-container-lowest py-space-md xl:block">
        <div className="flex items-center justify-between gap-space-sm px-gutter font-code-sm text-code-sm text-on-surface-variant">
          <span>FACE DATA STAYS ON THIS MACHINE · PHOTOS ARE DELETED AFTER ENROLLMENT</span>
          <span>GATELOG · SAI RESIDENCY PG</span>
        </div>
      </footer>

      {/* phone + tablet nav */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-surface-variant bg-surface-container-lowest/95 backdrop-blur-xl xl:hidden"
        aria-label="Main"
      >
        {NAV.filter((i) => i.phone).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center justify-center gap-0.5 py-2 font-label-caps text-label-caps ${
                isActive ? 'text-primary' : 'text-on-surface-variant'
              }`
            }
          >
            <Icon name={item.icon} className="text-xl" />
            {item.short}
          </NavLink>
        ))}
        <OverrideButton compact />
      </nav>
    </div>
  );
}

export default function AppLayout({ children }) {
  return (
    <OverrideProvider>
      <Shell>{children}</Shell>
    </OverrideProvider>
  );
}
