import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getEnrollment, getGuests, startEnrollment } from '../api';
import { Avatar, Icon } from '../components/StatusBits';

/**
 * Adding a guest, for someone who has never heard the word "enrollment".
 *
 * The page is three plain questions — who, what do they look like, have they
 * agreed — and one button. Everything technical is either done quietly or
 * explained in the same words a person would use out loud.
 *
 * Photos are shrunk in the browser before they're sent. A phone photo is
 * several megabytes and 4000px wide; the recogniser wants a face over 110px,
 * which 1600px gives it many times over. Sending the originals over PG wifi
 * to a mini PC would be slow for no gain.
 */

const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.9;
const POLL_MS = 1500;

const HEIC = /\.(heic|heif)$/i;

async function decode(file) {
  // createImageBitmap honours the rotation flag phones write into photos.
  // Without it, a portrait shot arrives on its side and the face is missed.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the img path below */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not read'));
    };
    img.src = url;
  });
}

/** File -> { filename, data } with the long edge capped. */
async function shrink(file) {
  const source = await decode(file);
  const w = source.width;
  const h = source.height;
  if (!w || !h) throw new Error('could not read');

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === 'function') source.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    filename: file.name || 'photo.jpg',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    preview: dataUrl,
  };
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-label-caps text-label-caps uppercase text-on-surface-variant">
        {label}
        {hint && <span className="ml-2 font-normal normal-case tracking-normal text-outline">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded bg-surface-container px-space-md py-2.5 font-body-md text-body-md text-on-surface '
  + 'placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 focus:ring-primary transition-all';

export default function AddGuest() {
  const [name, setName] = useState('');
  const [roomNo, setRoomNo] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [photos, setPhotos] = useState([]);

  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState(null);
  const [job, setJob] = useState(null);
  const [done, setDone] = useState(null);

  const fileRef = useRef(null);
  const pollRef = useRef(null);

  // The enrolled-guests panel. Reloaded whenever an enrollment finishes so a
  // new guest shows up without a refresh.
  const [roster, setRoster] = useState([]);
  const [rosterError, setRosterError] = useState(null);
  const [rosterQuery, setRosterQuery] = useState('');
  const loadRoster = useCallback(
    () =>
      getGuests()
        .then((rows) => {
          setRoster(rows.filter((g) => g.active));
          setRosterError(null);
        })
        .catch((e) => setRosterError(e.message)),
    []
  );
  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  const addFiles = useCallback(
    async (fileList) => {
      const chosen = Array.from(fileList || []);
      if (!chosen.length) return;
      setProblem(null);

      const iphone = chosen.find((f) => HEIC.test(f.name));
      if (iphone) {
        setProblem(
          `${iphone.name} is an iPhone HEIC photo, which this system can\u2019t read. `
          + 'On the iPhone: Settings \u203a Camera \u203a Formats \u203a Most Compatible, then take '
          + 'the photos again. Or send them to yourself on WhatsApp first, which turns '
          + 'them into ordinary photos.'
        );
        return;
      }

      const room = MAX_PHOTOS - photos.length;
      if (room <= 0) {
        setProblem(`That\u2019s already ${MAX_PHOTOS} photos, which is plenty.`);
        return;
      }

      setReading(true);
      try {
        const accepted = [];
        for (const file of chosen.slice(0, room)) {
          if (!/^image\//.test(file.type)) {
            setProblem(`${file.name} isn\u2019t a photo.`);
            continue;
          }
          try {
            accepted.push(await shrink(file));
          } catch {
            setProblem(`${file.name} couldn\u2019t be opened. Try a different photo.`);
          }
        }
        if (accepted.length) setPhotos((current) => [...current, ...accepted]);
        if (chosen.length > room) {
          setProblem(`Only the first ${room} were added \u2014 ${MAX_PHOTOS} is the most that helps.`);
        }
      } finally {
        setReading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [photos.length]
  );

  const removePhoto = (index) =>
    setPhotos((current) => current.filter((_, i) => i !== index));

  // --- the job ------------------------------------------------------------

  useEffect(() => () => clearInterval(pollRef.current), []);

  const submit = async (event) => {
    event.preventDefault();
    setProblem(null);

    try {
      const started = await startEnrollment({
        name: name.trim(),
        roomNo: roomNo.trim(),
        phone: phone.trim(),
        consent,
        photos: photos.map(({ filename, data }) => ({ filename, data })),
      });
      setJob(started);

      pollRef.current = setInterval(async () => {
        try {
          const latest = await getEnrollment(started.id);
          if (latest.status === 'running') {
            setJob(latest);
            return;
          }

          clearInterval(pollRef.current);
          setJob(null);
          if (latest.status === 'done') {
            setDone(latest.guest);
            loadRoster();
          } else {
            // Clearing the job is what takes the spinner down. Without it a
            // failed enrollment sits there turning forever.
            setProblem(latest.error || 'Adding the guest failed. Please try again.');
          }
        } catch (err) {
          clearInterval(pollRef.current);
          setJob(null);
          setProblem(err.message);
        }
      }, POLL_MS);
    } catch (err) {
      setProblem(err.message);
    }
  };

  const reset = () => {
    setName('');
    setRoomNo('');
    setPhone('');
    setConsent(false);
    setPhotos([]);
    setDone(null);
    setJob(null);
    setProblem(null);
  };

  // --- what's stopping us -------------------------------------------------

  const blocker = !name.trim()
    ? 'Enter the guest\u2019s name'
    : !roomNo.trim()
      ? 'Enter a room number'
      : photos.length < MIN_PHOTOS
        ? `Add ${MIN_PHOTOS - photos.length} more photo${MIN_PHOTOS - photos.length === 1 ? '' : 's'}`
        : !consent
          ? 'Tick the consent box'
          : null;

  // --- states -------------------------------------------------------------

  const needMore = Math.max(0, MIN_PHOTOS - photos.length);
  const q = rosterQuery.trim().toLowerCase();
  const shownRoster = roster.filter(
    (g) => !q || g.name.toLowerCase().includes(q) || g.room_no.toLowerCase().includes(q)
  );

  let panel;

  if (done) {
    panel = (
      <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-md">
        <div className="flex items-start gap-space-md rounded-xl bg-secondary/10 p-space-md">
          <Icon name="check_circle" fill className="text-3xl text-secondary" />
          <div>
            <h2 className="font-headline-md text-headline-md text-secondary">{done.name} has been added</h2>
            <p className="mt-2 font-body-md text-body-md text-on-surface-variant">
              Room {done.room_no}, learned from {done.photo_count} photos. The camera starts recognising
              them within a few seconds — nothing else to do.
            </p>
            <p className="mt-2 font-body-md text-body-md text-on-surface-variant">
              The photos have been deleted. Only the face measurements are kept, and those can be removed
              again whenever the guest asks.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-primary px-4 py-2.5 font-body-md text-body-md font-semibold text-on-primary transition-colors hover:bg-primary-fixed"
          >
            Add another guest
          </button>
          <Link
            to={`/guests/${done.id}`}
            className="rounded-lg bg-surface-container-high px-4 py-2.5 font-body-md text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
          >
            See their page
          </Link>
        </div>
      </div>
    );
  } else if (job && job.status === 'running') {
    panel = (
      <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-md">
        <h2 className="font-headline-md text-headline-md">Adding {job.name}…</h2>
        <div className="flex items-start gap-3 rounded-xl bg-surface-container px-5 py-5">
          <span
            className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-outline-variant border-t-primary"
            aria-hidden="true"
          />
          <div>
            <p className="font-body-md text-body-md">
              Learning {job.name}’s face from {job.photo_count} photos.
            </p>
            <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
              This takes up to a minute, and several minutes the very first time. You can leave this page
              open — it will say when it’s finished.
            </p>
          </div>
        </div>
      </div>
    );
  } else {
    panel = (
      <form
        onSubmit={submit}
        className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-md"
      >
        <div className="flex items-center gap-space-xs pb-space-sm">
          <Icon name="person_add" className="text-xl text-primary" />
          <h2 className="font-headline-md text-headline-md">Enroll New Resident</h2>
        </div>

        {problem && (
          <div role="alert" className="rounded-lg border border-tertiary/30 bg-tertiary/10 px-4 py-3">
            <p className="font-body-md text-body-md text-tertiary">{problem}</p>
          </div>
        )}

        <Field label="Full name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Asha Kulkarni"
            autoComplete="off"
          />
        </Field>

        <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
          <Field label="Room number">
            <input
              className={`${inputClass} font-code-tabular text-code-tabular`}
              value={roomNo}
              onChange={(e) => setRoomNo(e.target.value)}
              placeholder="204"
              autoComplete="off"
            />
          </Field>
          <Field label="Phone" hint="optional">
            <input
              className={`${inputClass} font-code-tabular text-code-tabular`}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              autoComplete="off"
              inputMode="tel"
            />
          </Field>
        </div>

        <div className="mt-space-xs flex flex-col gap-space-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-label-caps text-label-caps uppercase text-on-surface-variant">
              <Icon name="center_focus_strong" className="text-sm text-primary" />
              Face photos ({MIN_PHOTOS}–{MAX_PHOTOS})
            </span>
            <span className={`font-code-sm text-code-sm ${needMore ? 'text-tertiary' : 'text-secondary'}`}>
              {photos.length} of {MIN_PHOTOS} needed{!needMore && ' — enough'}
            </span>
          </div>

          <div className="mt-space-xs grid grid-cols-3 gap-space-sm sm:grid-cols-4">
            {photos.map((photo, i) => (
              <div key={`${photo.filename}-${i}`} className="relative flex flex-col rounded-lg bg-surface-container p-1.5">
                <img
                  src={photo.preview}
                  alt={photo.filename}
                  className="aspect-square w-full rounded object-cover"
                />
                <span className="absolute left-2.5 top-2.5 flex rounded-full bg-secondary p-0.5 text-on-secondary shadow">
                  <Icon name="check" className="text-xs font-bold" />
                </span>
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove ${photo.filename}`}
                  className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-surface-container-highest text-on-surface shadow hover:bg-error-container"
                >
                  <Icon name="close" className="text-sm" />
                </button>
                <span className="mt-1 truncate font-code-sm text-code-sm text-on-surface-variant">
                  Photo {i + 1}
                </span>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={reading}
                className="flex min-h-[7rem] flex-col items-center justify-center rounded-lg bg-surface-container-lowest p-2 text-center transition-all hover:bg-surface-container disabled:opacity-50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-primary">
                  <Icon name="add_a_photo" className="text-lg" />
                </span>
                <span className="mt-1.5 font-label-caps text-label-caps text-on-surface">
                  {reading ? 'Opening…' : photos.length ? 'Add more' : 'Choose photos'}
                </span>
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-container-lowest p-space-md">
          <span className="flex items-center gap-1 font-label-caps text-label-caps uppercase text-on-surface-variant">
            <Icon name="info" className="text-xs text-tertiary" /> Good photos
          </span>
          <ul className="grid grid-cols-1 gap-1 font-code-sm text-code-sm text-on-surface-variant sm:grid-cols-2">
            {[
              'One person per photo',
              'No sunglasses or mask',
              'A little different each time',
              'Face fills a good part of the frame',
            ].map((tip) => (
              <li key={tip} className="flex items-center gap-1.5">
                <Icon name="check_circle" className="text-xs text-secondary" />
                {tip}
              </li>
            ))}
          </ul>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-surface-container p-space-md">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
          />
          <span className="font-body-md text-body-md">
            This guest has agreed in writing to face recognition being used at the entrance.
            <span className="mt-1 block font-body-sm text-body-sm text-on-surface-variant">
              Their face measurements stay on this machine and can be deleted whenever they ask. The photos
              are deleted as soon as the face has been learned.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-space-xs pt-space-xs">
          <button
            type="submit"
            disabled={Boolean(blocker) || reading}
            className="flex w-full items-center justify-center gap-2 rounded bg-primary px-space-md py-3 font-headline-md text-headline-md font-semibold tracking-wide text-on-primary shadow-lg transition-colors hover:bg-primary-fixed active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="model_training" className="text-xl" /> Add this guest
          </button>
          {blocker ? (
            <p className="text-center font-code-sm text-code-sm text-on-surface-variant">{blocker} first.</p>
          ) : (
            <p className="flex items-center justify-center gap-1 font-code-sm text-code-sm text-on-surface-variant">
              <Icon name="verified_user" className="text-xs text-secondary" /> Stays on this machine · nothing goes to the cloud
            </p>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      <div className="relative flex flex-col justify-between gap-space-md overflow-hidden rounded-xl bg-surface-container-low p-space-lg shadow-md xl:flex-row xl:items-center">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/5 blur-3xl" />
        <div className="z-10 flex flex-col gap-space-xs">
          <h1 className="font-headline-lg text-headline-lg tracking-tight">Add a Guest</h1>
          <p className="max-w-2xl font-body-md text-body-md text-on-surface-variant">
            Fill in who they are and add three to eight photos. The camera will recognise them from then on.
          </p>
        </div>
        <div className="z-10 rounded-lg bg-surface-container-lowest/80 p-space-md">
          <span className="font-label-caps text-label-caps uppercase text-on-surface-variant">Enrolled</span>
          <div className="font-headline-lg text-headline-lg tabular-nums text-secondary">{roster.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-space-lg xl:grid-cols-12">
        <div className="xl:col-span-5">{panel}</div>

        <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-md xl:col-span-7">
          <div className="flex flex-col justify-between gap-space-md md:flex-row md:items-center">
            <div>
              <h2 className="font-headline-md text-headline-md">Enrolled Guests</h2>
              <p className="font-code-sm text-code-sm text-on-surface-variant">
                {roster.length} with face data on this machine
              </p>
            </div>
          </div>

          <div className="relative">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-on-surface-variant" />
            <input
              type="search"
              value={rosterQuery}
              onChange={(e) => setRosterQuery(e.target.value)}
              placeholder="Search name or room number…"
              aria-label="Search enrolled guests"
              className="w-full rounded-lg bg-surface-container-lowest py-2.5 pl-9 pr-3 font-body-md text-body-md placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {rosterError && (
            <p className="rounded-lg bg-tertiary/10 px-4 py-3 font-body-md text-body-md text-tertiary" role="alert">
              Couldn&rsquo;t load the guest list: {rosterError}
            </p>
          )}

          {!rosterError && shownRoster.length === 0 && (
            <p className="rounded-lg border border-dashed border-outline-variant px-4 py-space-lg text-center font-body-md text-body-md text-on-surface-variant">
              {roster.length === 0 ? 'No one is enrolled yet.' : 'No guest matches that.'}
            </p>
          )}

          <ul className="grid max-h-[40rem] grid-cols-1 gap-space-sm overflow-y-auto md:grid-cols-2">
            {shownRoster.map((g) => (
              <li key={g.id} className="flex flex-col gap-space-sm rounded-lg bg-surface-container p-space-md">
                <div className="flex items-center gap-space-sm">
                  <Avatar name={g.name} />
                  <div className="min-w-0">
                    <p className="truncate font-body-md text-body-md font-semibold">{g.name}</p>
                    <p className="font-code-tabular text-code-tabular text-primary">
                      Rm {g.room_no}
                      {g.photo_count > 0 && (
                        <span className="text-on-surface-variant"> · {g.photo_count} photos</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded bg-surface-container-lowest px-2 py-1.5 font-code-sm text-code-sm text-on-surface-variant">
                  <span>
                    {g.enrolled_at
                      ? `Enrolled ${new Date(g.enrolled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : 'Enrolled'}
                  </span>
                  <Link to={`/guests/${g.id}`} className="font-semibold text-primary hover:underline">
                    HISTORY →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
