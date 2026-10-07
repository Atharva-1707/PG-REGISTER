# PG entry/exit register

Face recognition at the entrance replaces the paper sign-in book. Two cameras
watch the door (one for people coming in, one for people going out), a mini PC recognises which of the enrolled guests just walked
past, and the register updates itself.

Built on the K.A.V.A.C.H codebase: the flat JSON store, the Express scaffold,
the app shell and the dashboard/detail page structure carry over. The Gemini
document-analysis flow does not.

```
entrance camera ─┐
                  ├─► recognition service ──► Express API ──► register dashboard
outside camera ──┘            │                            │
              data/embeddings.json          data/logs.json
              (never leaves the box)        data/guests.json
```

## Quick start

Nothing here needs a camera. The register runs on fake data first, by design.

```bash
./setup.sh              # copies .env files, installs backend + frontend deps
npm test                # backend, frontend time logic, recognition — no camera needed
npm run seed            # 20 fake guests, a day of movements
npm run dev:api         # terminal 1 — API on :4000
npm run dev:ui          # terminal 2 — dashboard on :5173
```

Open http://localhost:5173. Set the same `SERVICE_TOKEN` in `backend/.env`,
`recognition/.env` and `frontend/.env`, or manual entries come back 401.

The recognition service is stage 3 below — don't install it until the register
works on seeded data.

## What's here

```
recognition/
  core.py            matching, tracking, direction, camera roles, motion gate, overlay — no I/O
  test_core.py       32 tests, run without a camera or a model
  test_service.py    17 tests: the whole camera loop (one camera and two), with OpenCV and the model stubbed
  list_cameras.py    which camera number is which — run it with both cameras plugged in
  enroll.py          add a guest from 3–8 reference photos, or --remove several. --json for the dashboard
  service.py         the always-on camera loop
  requirements.txt
  .env.example
backend/
  package.json
  .env.example
  server/db.js       flat JSON store; toggle, day rollover, idempotency
  server/index.js    REST API
  server/live-view.js    the door view relay: one frame per camera in memory, and backpressure
  server/cameras.js      which camera is the entrance and which is outside (the Swap button)
  server/enroll-jobs.js  runs enroll.py for the dashboard's Add a guest form
  server/guest-removal.js  runs enroll.py --remove for the guest list's multi-select
  server/guest-removal.test.js  7 tests
  server/outpass.js, mailer.js  outpasses and the parent email
  server/public-server.js, approval-page.js  the parent's approve/decline pages (own port)
  server/outpass.test.js        25 tests, no mail server needed
  server/db.test.js  17 tests
  server/routes.test.js  14 tests
  server/live-view.test.js  28 tests
  scripts/seed-demo.js   fake data so the UI works before the camera exists
frontend/
  package.json, vite.config.js, tailwind.config.js, postcss.config.js
  index.html
  .env.example
  src/main.jsx       React entry point
  src/App.jsx        routes
  src/api.js         API client
  src/index.css      Tailwind directives
  src/time.js        manual-entry time rules (pure, tested in time.test.js)
  src/components/    AppLayout.jsx, StatusBits.jsx, OverrideModal.jsx, OverrideContext.jsx
  src/pages/         Register.jsx (live dashboard), DoorCamera.jsx, AddGuest.jsx,
                     GuestList.jsx, GuestDetail.jsx, UnknownFaces.jsx,
                     OpenOverride.jsx (keeps /log working)
data/                guests.json, embeddings.json, logs.json, unknown.json
setup.sh             first-run setup, safe to re-run
```

`data/` is gitignored. `embeddings.json` is biometric data for real people —
it must never reach a remote.

### The interface

The UI follows the GateLog design (the Stitch export): dark tonal surfaces, cyan
for telemetry, emerald for *in*, amber for *out*. The colour, type and spacing
tokens in `frontend/tailwind.config.js` are copied from its `DESIGN.md`, so class
names like `bg-surface-container` and `text-secondary` match the mockups. Inter,
JetBrains Mono and the Material Symbols icons are installed from npm and served
by the app itself — nothing is fetched from Google, so it works on a PG network
with no internet.

Where the mockups showed things the register has no data for, they are
**left out rather than faked**: curfew and compliance, capacity ("20 / 20 Max"),
floor names, guardian/emergency contacts, the gate buzzer and emergency lock,
"neural weights" and AES-256 claims, PDF export, profile editing, and guest
photos. In particular the register never stores a photograph, so avatars are
initials. Match scores are cosine similarity as the recogniser reports them
(`0.62`), not percentages — a "98.4%" would imply a certainty the number doesn't
carry.

**Manual override** is a dialog, opened from the header, a guest's page or the
dashboard drawer (and `/log`). It can back-date an entry to *earlier today* —
never before the 4am rollover, never in the future. The API enforces the same:
`POST /api/logs` rejects an unparsable or future `timestamp` with a 400.

### Routes

| Method | Path | Who calls it |
|---|---|---|
| GET | `/api/health` | anything checking the box is up |
| GET | `/api/summary` | register header, service-health dot |
| GET | `/api/guests` | guest list, manual-entry picker |
| GET | `/api/guests/:id` | guest detail |
| GET | `/api/outpasses` | outpasses, newest first (`?status=issued`, `?guest_id=`) |
| POST | `/api/outpasses` | issue an outpass and email the parent — needs the token |
| POST | `/api/outpasses/:id/resend` | send the email again — needs the token |
| POST | `/api/outpasses/:id/close` | `{ status: "returned" \| "cancelled" }` — needs the token |
| GET/POST | `/outpass/respond` | **public port only (4001)**: the parent's page. GET shows, POST decides; authorised by the pass token |
| GET/POST | `/api/parents/:guest_id` | saved parent contact for a student (POST needs the token) |
| POST | `/api/guests/remove` | guest list multi-select, `{ ids: [...] }` — needs the token. Deletes face data, keeps visit history |
| POST | `/api/logs` | recognition service, manual entry (optional `timestamp`, validated) — needs the token |
| GET | `/api/logs` | register, guest detail. `?date= &guest_id= &limit=` |
| POST | `/api/unknown` | recognition service — needs the token |
| GET | `/api/unknown` | unknown faces page |
| POST | `/api/preview` | recognition service, a door frame (`cam` says which camera) — needs the token |
| GET | `/api/cameras` | which camera is the entrance and which is outside; the door screen and the recognition service both read it |
| POST | `/api/cameras` | the Swap button, `{ swapped: true \| false }` — needs the token |
| GET | `/api/preview?cam=1\|2` | the door screen, one camera. Asking is what keeps that camera's feed alive |
| GET | `/api/preview/state?cam=1\|2` | recognition service, asking whether to bother |
| POST | `/api/preview/state` | the live view switch (both cameras) — needs the token |
| POST | `/api/enroll` | Add a guest form — needs the token |
| GET | `/api/enroll/:jobId` | Add a guest form, polling its progress |

`embeddings.json` has no route. The API never reads it.

### Outpasses and parent emails

**Outpass** in the top bar (or **Issue Outpass** on a guest's page): pick the student,
confirm the parent's email, choose a reason and leaving time, and press *Issue outpass and
email parent*. The parent gets an email with the student, destination, reason, leaving and
expected return times, and the pass number. The email address is remembered for next time.

- One open pass per student. **Mark returned** or **Cancel** closes it; a pass past its
  expected return time shows **Overdue**.
- **Print** opens a slip the student can show at the gate; **Resend email** retries.
- If the email cannot be sent, the pass is still issued and the page says why.
- Data: `data/outpasses.json` and `data/parents.json` (written by the backend only).

Email setup, in `backend/.env` (then `cd backend && npm install`, and restart the API):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=<16-letter App Password>
PG_CONTACT=+91 98xxxxxxx
```

Gmail needs an **App Password** (Google Account → Security → 2-Step Verification → App
passwords); the normal password is refused. With `SMTP_HOST` empty nothing is sent: each
email is saved as a text file in `data/outbox/`, which is the safe way to try it first.

### Parent approval (Approve / Decline buttons)

The email now asks the parent. It has two buttons; each opens a small page showing the
request with one confirm button (the extra tap is deliberate: mail scanners open every
link, so a link that decided on open would answer before the parent had read anything).
Their answer shows on the **Outpass** page within a few seconds:

- **Awaiting parent** → **Approved** (print the slip, let them go) or **Declined by parent**
  (with their reason, if they gave one; the pass closes and the student can be re-requested).
- The first answer is final. Buttons stop working after `APPROVAL_TTL_HOURS` (72), or once you
  cancel or close the pass. **Resend request** gives the same email a fresh window.
- The printed slip says APPROVED, DECLINED or Awaiting, never more than the parent said.

**Security.** Each pass has a private random token that only exists in that parent's email
(it is never returned by the dashboard API). The approval pages run on their own port
(`PUBLIC_PORT`, 4001) in a separate app that can reach nothing else: no roster, no log, no
other pass. Wrong ids and wrong tokens get the same generic page.

### Letting parents reach the approval page

A parent's phone cannot open `http://localhost:4001`. For real use, give port **4001** (and
only 4001; never 4000, which lists every student) a public address, then put it in
`backend/.env` as `PUBLIC_URL=https://...` and restart. The easiest free way is a Cloudflare
quick tunnel:

```
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:4001
```

It prints an address like `https://something.trycloudflare.com`. Quick-tunnel addresses
change every time you start it, and old emails then stop working; for a fixed address use a
named Cloudflare tunnel or any host that can forward to port 4001. Until `PUBLIC_URL` is set,
the Outpass page shows a warning and the buttons only work on the computer running the register.

### Removing guests

On **Guest List**, press and hold a guest (or tap **Select**), tick as many as you
like, and press **Remove**. It deletes their face data and takes them off the list;
their past movements stay in the register. From a terminal:
`python3 enroll.py --keep-record --remove <id> <id> ...`.

One thing to know: `GET /api/preview` is open, like every other GET here. That
is consistent with the rest — the roster, the movements and the guest history
are open too — and the whole API is meant to sit on a trusted LAN behind
`CORS_ORIGIN`. But a live picture of your doorway is a step up in sensitivity
from a list of room numbers. If the PG wifi is shared with guests, put the
token on the GETs too, or keep the dashboard on a separate network.

## Bring it up in stages

Each stage is testable on its own. Don't move on until the one before it works.

**1 — Register logic, no hardware needed**

```bash
npm test
```

**2 — API and dashboard, still no camera**

```bash
npm run seed
npm run dev:api
npm run dev:ui      # in another terminal
```

You should get a working register on fake data, including manual entry. Delete
`data/*.json` before enrolling anyone real.

**3 — Enrollment**

```bash
pip install -r recognition/requirements.txt
cd recognition
python3 enroll.py --name "Asha Kulkarni" --room 204 \
    --photos photos/asha/*.jpg --consent-given
python3 enroll.py --list
```

Good reference photos: 3–5 per guest, phone camera at arm's length, indoor
light, one with glasses on and one without if they wear them, one slightly
turned. `enroll.py` rejects photos with no face, more than one face, a face
under 110px or visible blur, and warns if one photo looks like a different
person from the rest.

**4 — Recognition, against a recording first**

Stand at the door and film thirty seconds of people walking in and out on a
phone, then:

```bash
cd recognition
python3 service.py --source clip.mp4 --no-post --window
```

It prints what it would have logged. Get the names and directions right on the
recording before you point it at the live register. Then drop `--no-post`.

`--window` (still accepted as `--preview`) needs a display and the non-headless
OpenCV build. On a headless mini PC, drop it and read the log lines instead —
or just open the dashboard's **At the door** page, which needs neither.

## What it costs the mini PC

Face detection is the expensive part — roughly 100ms a frame on an N100, which
is most of a core if you run it on every frame. The original loop did exactly
that, all day, whether or not anybody was at the door.

Two changes deal with that, and neither asks the warden to remember anything.

**The motion gate.** Before each frame reaches the detector it gets compared to
the previous one on an 80px-wide thumbnail. No movement, no detection. A
doorway is empty the overwhelming majority of the day, so most frames stop
there, for microseconds instead of 100ms. Movement wakes it instantly, it keeps
looking for a second and a half afterwards so someone who stops dead at the
door is still seen, and it sweeps every couple of seconds regardless so a
person standing perfectly still can never be invisible.

`test_service.py` plays a corridor through the real loop and counts: a clip
that's about 4% occupied costs **80% fewer detections** with the gate on, and
produces byte-identical register entries. A real doorway is idle far more than
96% of the time, so expect better. The service prints the share of frames it
skipped every 300 frames — that number is the one to watch.

**The live view only runs while someone is watching it.** The recognition
service asks the backend whether a browser has requested a frame in the last
ten seconds. If none has, it doesn't encode anything at all. Close the tab,
switch pages, let the phone screen sleep, and the cost goes away within a few
seconds by itself. The switch on the door screen is the manual version of the
same thing, for when the screen has to stay up but the box is busy.

Worth being clear about what the switch does *not* do: detection and the
register are unaffected either way. Turning the live view off saves the JPEG
encode and the network, which is real but small — single-digit percent. The
motion gate is where the actual saving is. If the box is still struggling with
the gate on, the next levers are `MAX_FPS`, then `MODEL_PACK=buffalo_s`, then
`DETECT_WIDTH`.

## Adding a guest from the dashboard

The warden opens **Add a guest**, types a name and room, picks 3–8 photos, ticks
the consent box, and presses one button. Behind that:

* Photos are shrunk to 1600px in the browser before they're sent. A phone photo
  is several megabytes; the recogniser wants a face over 110px, which 1600px
  gives many times over. iPhone rotation flags are honoured, or portrait shots
  arrive sideways and the face is missed.
* The backend writes them to a scratch directory, runs `enroll.py --json`, and
  **deletes them the moment the job ends**, pass or fail. What survives is the
  embedding. The register never stores a photograph of anybody.
* Because the model load takes tens of seconds — minutes on the very first run,
  while the model pack downloads — this is a job the page polls, not a request
  that hangs.
* The recognition service notices the new guest within `GALLERY_POLL_SECONDS`
  and starts matching them. No restart, no terminal.
* HEIC photos get told what to do about it by name, because an iPhone on
  default settings is the most likely way this goes wrong in practice.

`enroll.py` still works exactly as it did from the command line.

## Two cameras: one for in, one for out

```
   outside                      PG door                      inside
                                   │
  Cam 2  ◄── people leaving walk   │   people arriving walk ──►  Cam 1
 "outside camera"   toward it      │   toward it           "entrance camera"
  marks OUT                        │                         marks IN
```

* **Cam 1, the entrance camera**, faces the PG door from inside. Every enrolled
  student it recognises is logged **in**.
* **Cam 2, the outside camera**, faces away from the door, outward. Every
  enrolled student it recognises is logged **out**.
* The direction comes from *which camera* saw the face. It no longer has to be
  guessed from whether the face box is growing, so a student who stops at the
  door, or walks in at an angle, is still logged correctly. (With one camera,
  the old face-box method still applies; see "Direction" below.)
* **Swap cameras**, on the **At the Door** page, trades the two jobs: Cam 1
  becomes the outside camera and Cam 2 the entrance one. Use it if the cameras
  ended up mounted or plugged in the other way round. It is saved, takes
  effect within a few seconds, and needs no restart or `.env` edit. Any walk-past
  that was half-finished at the moment of the swap is dropped rather than
  logged under the wrong job.
* The door page shows both pictures side by side, in plug-in order (Cam 1 on
  the left), each labelled with its current job. Each picture is only made
  while its panel is open, same as before.
* Every movement records which camera saw it (`camera: "1"` / `"2"` in
  `logs.json`).
* **One person, two cameras.** If the views overlap, the second camera ignores a
  guest the first one just logged, for `CROSS_CAMERA_SECONDS` (8). Otherwise
  someone stepping through the door could appear as "in" then "out" a second
  later. The same camera is still protected by the normal cooldown.

**Where to mount them.** A face is only recognised when it points at the lens,
so each camera must be placed where the people it is meant to log are
*walking toward it*. People arriving walk toward the entrance camera; people
leaving must walk toward the outside camera, so it has to be positioned on the
far side of the door, looking back toward it. A camera that merely faces
outward sees people *arriving* face-on and would log them as leaving. If you
ever see arrivals logged as exits (or the reverse), the cameras are swapped
or pointing the wrong way: press **Swap cameras**, or re-aim them.

### Setting up on a laptop with its own camera + an external webcam

1. Plug the webcam in, then find the numbers:
   ```bash
   cd recognition
   python3 list_cameras.py            # lists what answers
   python3 list_cameras.py --show     # opens each camera, numbered, to see which is which
   ```
   (`--show` needs the non-headless OpenCV build; `pip install opencv-python`.)
   The built-in camera is usually `0` and the webcam `1`.
2. Put them in `recognition/.env`:
   ```
   CAMERA_1_SOURCE=0
   CAMERA_2_SOURCE=1
   ```
3. Start the service as usual (`python3 service.py`). The log says which camera
   is doing which job. Open **At the Door**: you should see both pictures.
4. If the picture on the left is the one that is actually outside, don't fix it
   in a file: press **Swap cameras**.

Things worth knowing:

* **The service starts with one camera if the other is missing.** Run it on the
  laptop camera alone today; it notices the webcam within `CAMERA_RETRY_SECONDS`
  (10) of being plugged in. No restart.
* **Only one program can use a camera at a time.** If a camera "has nothing
  there", close Teams, Zoom, the Windows Camera app and any browser tab using it.
* **Two cameras means twice the pictures to process.** If the laptop struggles,
  set `CAMERA_WIDTH=1280` and `CAMERA_HEIGHT=720` (a face at a doorway doesn't
  need 1080p), then `MAX_FPS`. The log prints frames per second per camera.
* **Dry run with two recordings:**
  `python3 service.py --source in.mp4 --source2 out.mp4 --no-post --window`
  (`--source` plays the entrance camera, `--source2` the outside one).
* Want the old single-camera behaviour? Delete the two `CAMERA_n_SOURCE` lines
  and set `CAMERA_SOURCE` instead.

## The two decisions worth knowing about

**Direction (one-camera setup).** With two cameras this section doesn't apply:
the camera decides. With one camera, the plan assumed a single camera can't tell which way someone is
walking, so each sighting toggled the guest's state. That works until one
recognition is missed, at which point every subsequent entry for that guest is
inverted, permanently and silently.

Two changes fix it. The service tracks each face across frames and reads the
direction from whether the box is growing or shrinking — growing means walking
toward the camera. When that read is confident it's sent as `direction`; when
it isn't, `direction` is null and the backend falls back to toggling. And the
register rolls over at 4am (`DAY_RESET_HOUR`), when everyone is home, so any
drift is bounded to a single day rather than accumulating for weeks.

(One camera only.) Set `APPROACH_MEANS=out` if the camera watches people leaving rather than
arriving.

**Liveness is opt-in, and off by default.** KAVACH's liveness check is
challenge-based — it wants the subject to blink or turn on cue, which doesn't
apply to someone walking past without stopping. What's wired in instead
(`core.check_liveness`) is a passive, coarse filter: it rejects a match whose
best frame is too blurry, has flat/uniform chroma (a screen replay), or has
too much glare (a print or screen catching the light), and logs it to
`/api/unknown` with a `liveness_*` reason instead of accepting it. It is not a
real anti-spoofing model and won't catch a good print or a high-end replay —
the threat it defends against (someone holding up a printed photo of a
housemate to fake a sign-in) is narrow for this use case, so it costs a color
crop per observation and some false rejections for a modest gain. Set
`LIVENESS_ENABLED=1` to turn it on, and tune `LIVENESS_BLUR_FLOOR`,
`LIVENESS_CHROMA_LOW`/`HIGH`, and `LIVENESS_GLARE_CEILING` in
`recognition/.env` against your own camera's footage before trusting it —
the defaults are starting points, same as `MATCH_THRESHOLD`.

## If the door screen stays blank

`recognition/service.py` reads `recognition/.env` on start (real environment
variables still win). The line it logs, `read N settings from .env`, tells you the
file was found. If instead you see `the register rejected our SERVICE_TOKEN`, the
token in `recognition/.env` differs from `backend/.env`: fix it, restart both. Movements
queue on disk in the meantime rather than being dropped.

## Tuning

`MATCH_THRESHOLD` (0.42) is the cosine similarity floor, and `MATCH_MARGIN`
(0.06) is how far the best guest must beat the runner-up. Both defaults are
starting points — tune them on your own faces, not on a blog post's numbers.

The way to tune: run for a week with `LOG_UNKNOWNS=1` and watch the unknown
faces page (or `GET /api/unknown`). Lots of rejections just above the threshold
means real guests are being missed — lower it, or re-enroll those guests with
better photos. Wrong names appearing in the register means the opposite — raise
the threshold and widen the margin. Missing a guest is cheap; putting the wrong
name in the register is not, so err high.

The unknown faces page shades near-misses against whatever you put in
`VITE_MATCH_THRESHOLD`. That is display only — the real threshold is the
recognition service's, so keep the two in step.

## Things I need from you before this is finished

1. **Camera.** What are you mounting, and where? Everything downstream depends
   on it. A face needs roughly 80–100 pixels across at the point people walk
   past, so a 1080p camera covering a 1.2m-wide doorway from 2–3m is about
   right. It needs to handle backlight — a camera pointed at a bright doorway
   from inside will silhouette everyone who walks in, and that alone will sink
   the whole thing. If it's an IP camera, set `CAMERA_SOURCE` to its RTSP URL;
   if USB, the index.

2. **`dlib` / `face_recognition` are not used** and I'd keep it that way. The
   stack here is InsightFace on ONNX Runtime, which pip-installs on the mini PC
   without a compiler. `dlib` needs a C++ toolchain and cmake, and its
   recognition model is noticeably weaker on the off-angle, motion-blurred
   frames a doorway produces. Tell me if you specifically need
   `face_recognition` for some other reason and I'll adapt `core.py` — the
   matching interface doesn't change, only the embedding call.

3. **OpenVINO is optional and I'd skip it for now.** Twenty faces on CPU is not
   the bottleneck; detection is. Get it working on plain `onnxruntime` first,
   measure the fps the service logs every 300 frames, and only if that's under
   about 6 fps switch to `onnxruntime-openvino` or drop `MODEL_PACK` to
   `buffalo_s`. Adding OpenVINO up front just means debugging two things at
   once.

4. **Consent.** `enroll.py` refuses to run without `--consent-given`, and
   `--remove` deletes a guest's face data when they move out. Face embeddings
   of twenty residents are biometric data under the DPDP Act, so get written
   consent at move-in and keep it with the tenancy paperwork. Worth deciding
   now, not after twenty people are enrolled.
