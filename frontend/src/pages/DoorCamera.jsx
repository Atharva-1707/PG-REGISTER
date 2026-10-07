import { useCallback, useEffect, useRef, useState } from 'react';
import { getCameras, getDoorView, getSummary, setCamerasSwapped, setDoorViewEnabled } from '../api';
import { Icon, Metric } from '../components/StatusBits';

/**
 * The door screen: both cameras, with names over the faces they know.
 *
 *   Entrance camera  faces the PG door from inside   -> faces it knows are coming IN
 *   Outside camera   faces away from the door        -> faces it knows are going OUT
 *
 * Which physical camera does which job is the Swap button. The panels stay in
 * the order the cameras are plugged in (Cam 1 on the left), and their labels
 * change, so pressing Swap visibly changes what each picture *means* without
 * the pictures themselves jumping around.
 *
 * Two things keep this cheap on the mini PC, and neither depends on the
 * warden remembering anything:
 *
 *   * The recognition service only makes pictures while a panel is asking for
 *     them. Close the tab, switch pages, or let the phone screen sleep, and the
 *     asking stops, so the picture-making stops a few seconds later.
 *   * The switch below is the deliberate version of the same thing, for when
 *     the screen has to stay open but the box is busy.
 *
 * Face detection itself is unaffected either way. The register keeps filling
 * in whether anyone is watching or not.
 */

const POLL_MS = 300;

const ROLES = {
  in: {
    title: 'Entrance camera',
    sub: 'Faces the PG door from inside',
    word: 'IN',
    where: 'at the entrance',
    badge: 'bg-secondary/15 text-secondary',
    icon: 'login',
  },
  out: {
    title: 'Outside camera',
    sub: 'Faces away from the door, outward',
    word: 'OUT',
    where: 'outside',
    badge: 'bg-tertiary/15 text-tertiary',
    icon: 'logout',
  },
};

/** Plain words for how sure the match is. The number is there too, small. */
function strength(score) {
  if (score == null) return null;
  if (score >= 0.58) return { label: 'Clear match', tone: 'text-secondary' };
  if (score >= 0.46) return { label: 'Good match', tone: 'text-secondary' };
  return { label: 'Close call', tone: 'text-tertiary' };
}

function FaceBox({ face }) {
  const known = face.known;
  const sure = strength(face.score);

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${face.x * 100}%`,
        top: `${face.y * 100}%`,
        width: `${face.w * 100}%`,
        height: `${face.h * 100}%`,
      }}
    >
      <div
        className={`h-full w-full rounded-sm border-2 ${
          known
            ? 'border-secondary shadow-[0_0_12px_rgba(16,185,129,0.35)]'
            : 'border-tertiary shadow-[0_0_12px_rgba(245,158,11,0.3)]'
        }`}
      />
      <div
        className={`absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap rounded px-2.5 py-1 text-center font-code-sm shadow-sm ${
          known ? 'bg-secondary text-on-secondary' : 'bg-tertiary text-on-tertiary'
        }`}
      >
        <p className="text-sm font-semibold uppercase leading-tight">{face.name}</p>
        {face.score != null && (
          <p className="text-[11px] leading-tight opacity-90">
            {sure?.label} · {face.score.toFixed(2)}
          </p>
        )}
      </div>
    </div>
  );
}

/** What to say when there's no picture, in words that suggest what to do. */
function Placeholder({ reason, offline, cam }) {
  const messages = {
    off: {
      title: 'Live view is switched off',
      body: 'The cameras are still watching and the register is still filling in. '
        + 'Switch the view back on when you want to see it.',
    },
    waiting: {
      title: `Waiting for camera ${cam}`,
      body: 'The picture should appear in a second or two. If it doesn\u2019t, the recognition '
        + 'service may not be running.',
    },
    camera_quiet: {
      title: `No picture from camera ${cam}`,
      body: 'The register is still working, but this camera hasn\u2019t sent anything for a few '
        + 'seconds. Check that it\u2019s plugged in, that no other app (Teams, Zoom, the Camera '
        + 'app) is using it, and that the recognition service is running.',
    },
    offline: {
      title: 'Can\u2019t reach the register',
      body: 'The computer isn\u2019t answering. Entries can still be made by hand from the '
        + 'Manual Override button once it\u2019s back.',
    },
  };
  const { title, body } = messages[offline ? 'offline' : reason] || messages.waiting;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 py-10 text-center">
      <Icon name="videocam_off" className="mb-2 text-3xl text-outline" />
      <p className="font-body-lg text-body-lg font-medium text-on-surface">{title}</p>
      <p className="mt-2 max-w-md font-body-md text-body-md text-on-surface-variant">{body}</p>
    </div>
  );
}

/** One camera: its own polling, its own picture, labelled with its current job. */
function CameraPanel({ cam, role, enabled, onEnabled }) {
  const [frame, setFrame] = useState(null);
  const [reason, setReason] = useState('waiting');
  const [offline, setOffline] = useState(false);

  // Kept in a ref as well as state: the polling loop reads it without
  // wanting to restart itself every time a frame lands.
  const enabledRef = useRef(true);
  const timerRef = useRef(null);
  const inFlightRef = useRef(false);
  const lastPollRef = useRef(0);

  const poll = useCallback(async () => {
    if (document.visibilityState === 'hidden') return;

    // One request at a time. A slow reply must not let calls pile up behind
    // each other: that turns a hiccup into a queue.
    if (inFlightRef.current) return;

    // Switched off, keep a slow heartbeat rather than going silent: someone
    // may switch the view back on from another screen, and this one should
    // notice without needing a refresh. Too slow to hold the feed open.
    const now = Date.now();
    if (!enabledRef.current && now - lastPollRef.current < 3000) return;

    inFlightRef.current = true;
    lastPollRef.current = now;
    try {
      const data = await getDoorView(cam);
      setOffline(false);
      enabledRef.current = data.enabled;
      onEnabled(data.enabled);
      setReason(data.reason);
      // Hold the last good picture rather than flashing to black between
      // frames. A doorway camera that strobes is unwatchable.
      if (data.frame) setFrame(data.frame);
      else if (data.reason !== 'ok') setFrame(null);
    } catch {
      setOffline(true);
      setFrame(null);
    } finally {
      inFlightRef.current = false;
    }
  }, [cam, onEnabled]);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);

    // Stop asking the moment the tab is hidden; the recognition service stops
    // encoding within a few seconds of the last request.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // The page's switch was pressed.
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      setFrame(null);
      setReason('off');
    } else {
      poll();
    }
  }, [enabled, poll]);

  const job = ROLES[role] || null;
  const faces = frame?.faces ?? [];
  const recognised = faces.filter((f) => f.known);
  const ratio = frame ? `${frame.width} / ${frame.height}` : '16 / 9';
  const live = enabled && !offline && Boolean(frame);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-headline-md text-headline-md leading-tight">
            {job ? job.title : `Camera ${cam}`}
          </p>
          <p className="font-code-sm text-code-sm text-on-surface-variant">
            Cam {cam}
            {job ? ` · ${job.sub}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {job && (
            <span
              className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 font-code-sm text-code-sm font-semibold ${job.badge}`}
            >
              <Icon name={job.icon} className="text-base" />
              marks {job.word}
            </span>
          )}
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-code-sm text-code-sm font-semibold ${
              live ? 'bg-primary/15 text-primary' : 'bg-surface-container-highest text-on-surface-variant'
            }`}
          >
            <span className="relative flex h-2 w-2" aria-hidden="true">
              {live && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-primary' : 'bg-outline'}`} />
            </span>
            {live ? 'LIVE' : enabled ? 'NO PICTURE' : 'PAUSED'}
          </span>
        </div>
      </div>

      <div
        className={`reticle relative w-full overflow-hidden rounded-2xl bg-surface-container-lowest ${
          live ? 'shadow-[0_0_16px_rgba(6,182,212,0.25)]' : ''
        }`}
        style={{ aspectRatio: ratio }}
      >
        {frame ? (
          <>
            <img
              src={`data:image/jpeg;base64,${frame.image}`}
              alt={`Camera ${cam}${job ? `, the ${job.title.toLowerCase()}` : ''}, as the camera sees it`}
              className="h-full w-full object-contain"
            />
            {faces.map((face, i) => (
              <FaceBox key={`${face.name}-${i}`} face={face} />
            ))}
            {faces.length === 0 && (
              <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-surface-container-lowest/80 px-3 py-1 font-code-sm text-code-sm text-on-surface-variant backdrop-blur-sm">
                Nobody in view
              </p>
            )}
          </>
        ) : (
          <Placeholder reason={reason} offline={offline} cam={cam} />
        )}
      </div>

      {enabled && !offline && frame && (
        <p className="font-body-md text-body-md text-on-surface-variant">
          {recognised.length > 0
            ? `${recognised.map((f) => f.name).join(', ')} ${recognised.length === 1 ? 'is' : 'are'} ${
                job ? job.where : 'in view'
              }${job ? ` \u2014 will be logged ${job.word}.` : '.'}`
            : faces.length > 0
              ? 'Someone is in view that this camera doesn\u2019t recognise.'
              : 'Nobody in view right now.'}
        </p>
      )}
    </section>
  );
}

export default function DoorCamera() {
  const [enabled, setEnabled] = useState(true);
  const [summary, setSummary] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [roles, setRoles] = useState(null); // { swapped, cameras: [{ id, role }] }
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState('');

  const roleOf = (id) => roles?.cameras?.find((c) => c.id === id)?.role ?? null;

  useEffect(() => {
    const load = () => getSummary().then(setSummary).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  // Roles rarely change, but another screen might swap them: check now and then.
  useEffect(() => {
    const load = () => getCameras().then(setRoles).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setSwitching(true);
    try {
      const state = await setDoorViewEnabled(next);
      setEnabled(state.enabled);
    } catch {
      /* the panels will show "can't reach the register" themselves */
    } finally {
      setSwitching(false);
    }
  };

  const swap = async () => {
    setSwapping(true);
    setSwapError('');
    try {
      setRoles(await setCamerasSwapped(!roles?.swapped));
    } catch (err) {
      setSwapError(err.message || 'Could not swap the cameras.');
    } finally {
      setSwapping(false);
    }
  };

  const camOneRole = roleOf('1');

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-headline-lg text-headline-lg">At the Door</h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            The entrance camera marks students <strong className="font-semibold text-secondary">in</strong>;
            the outside camera marks them <strong className="font-semibold text-tertiary">out</strong>.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={swap}
            disabled={swapping || !roles}
            title="Trade which camera watches the entrance and which watches the outside"
            className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-high px-4 py-2.5 font-body-md text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:opacity-60"
          >
            <Icon name="swap_horiz" className="text-xl" />
            {swapping ? 'Swapping\u2026' : 'Swap cameras'}
          </button>

          <button
            type="button"
            onClick={toggle}
            disabled={switching}
            aria-pressed={enabled}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 font-body-md text-body-md font-medium transition-colors disabled:opacity-60 ${
              enabled
                ? 'border-outline-variant bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
                : 'border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20'
            }`}
          >
            <Icon name={enabled ? 'pause_circle' : 'play_circle'} className="text-xl" />
            {enabled ? 'Turn live view off' : 'Turn live view on'}
          </button>
        </div>
      </header>

      {swapError && (
        <p role="alert" className="rounded-xl bg-error-container px-4 py-3 font-body-md text-body-md text-on-error-container">
          {swapError}
        </p>
      )}

      {roles?.swapped && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-container px-4 py-3 font-body-md text-body-md text-on-surface-variant">
          <Icon name="swap_horiz" className="mt-0.5 text-xl text-primary" />
          <span>
            Cameras are swapped: <strong className="font-semibold text-on-surface">Cam 1</strong> is watching the{' '}
            {camOneRole === 'out' ? 'outside' : 'entrance'} and{' '}
            <strong className="font-semibold text-on-surface">Cam 2</strong> the{' '}
            {camOneRole === 'out' ? 'entrance' : 'outside'}. Press Swap again to put them back.
          </span>
        </p>
      )}

      <div className="grid gap-space-lg lg:grid-cols-2">
        <CameraPanel cam="1" role={roleOf('1')} enabled={enabled} onEnabled={setEnabled} />
        <CameraPanel cam="2" role={roleOf('2')} enabled={enabled} onEnabled={setEnabled} />
      </div>

      {!enabled && (
        <p className="rounded-xl bg-surface-container px-4 py-3 font-body-md text-body-md text-on-surface-variant">
          The cameras are still working and the register is still filling in. Only the pictures on
          this screen are paused.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Guests" value={summary?.total_guests} />
        <Metric label="In" value={summary?.currently_in} tone="in" />
        <Metric label="Out" value={summary?.currently_out} tone="out" />
      </div>
    </div>
  );
}
