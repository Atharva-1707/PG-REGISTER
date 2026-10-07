# PG Register

**A face-recognition sign-in book for a 20-guest PG. Walk through the door, the register updates itself.**

Two cameras watch the entrance, one for people coming in and one for people going out. A mini PC works out which enrolled guest just walked past, and a dashboard shows who is in, who is out, and when they last moved. No paper, no cloud, no photos stored.

Built by adapting the [K.A.V.A.C.H](#where-this-came-from) codebase: the flat JSON store, the Express scaffold, the app shell and the dashboard/detail page layout all carried over. The Gemini document-analysis part did not.

```
 entrance camera ─┐
                  ├─► recognition service ──► Express API ──► register dashboard
 outside camera  ─┘          │                     │
                  data/embeddings.json       data/logs.json
                  (never leaves the box)     data/guests.json
```

**Jump to:** [Quick start](#quick-start) · [Project layout](#project-layout) · [Bringing it up](#bringing-it-up-in-stages) · [Two cameras](#two-cameras) · [Outpasses](#outpasses-and-parent-approval) · [API](#api) · [Tuning](#tuning) · [Hardware and consent](#hardware-and-consent)

---

## Quick start

You don't need a camera for this. The register runs on fake data first, on purpose.

```bash
./setup.sh              # copies .env files, installs backend and frontend deps
npm test                # backend, frontend time logic, recognition (no camera needed)
npm run seed            # 20 fake guests and a day of movements
npm run dev:api         # terminal 1: API on :4000
npm run dev:ui          # terminal 2: dashboard on :5173
```

Open <http://localhost:5173>.

Use the same `SERVICE_TOKEN` in `backend/.env`, `recognition/.env` and `frontend/.env`. If they differ, manual entries will come back with a 401.

The recognition service is stage 3 below. Don't install it until the register works on seeded data.

---

## Project layout

```
recognition/
  core.py             matching, tracking, direction, camera roles, motion gate, overlay (no I/O)
  test_core.py        32 tests, no camera or model needed
  test_service.py     17 tests of the whole camera loop, OpenCV and the model stubbed
  list_cameras.py     tells you which camera number is which
  enroll.py           add a guest from 3-8 photos, or --remove several. --json for the dashboard
  service.py          the always-on camera loop
  requirements.txt
  .env.example

backend/
  server/db.js              flat JSON store: toggling, day rollover, idempotency
  server/index.js           REST API
  server/live-view.js       door view relay: one frame per camera, in memory, with backpressure
  server/cameras.js         which camera is the entrance and which is outside (the Swap button)
  server/enroll-jobs.js     runs enroll.py for the Add a guest form
  server/guest-removal.js   runs enroll.py --remove for multi-select
  server/outpass.js, mailer.js
  server/public-server.js, approval-page.js    the parent's approve/decline pages (own port)
  scripts/seed-demo.js      fake data so the UI works before any camera exists
  *.test.js                 db (17), routes (14), live-view (28), outpass (25), guest-removal (7)

frontend/
  src/App.jsx, api.js, time.js, index.css
  src/components/     AppLayout, StatusBits, OverrideModal, OverrideContext
  src/pages/          Register, DoorCamera, AddGuest, GuestList, GuestDetail,
                      UnknownFaces, OpenOverride (keeps /log working)

data/                 guests.json, embeddings.json, logs.json, unknown.json
setup.sh              first-run setup, safe to re-run
```

`data/` is gitignored. `embeddings.json` is biometric data about real people and must never be pushed to a remote.

---

## The interface

The UI follows the GateLog design from the Stitch export: dark tonal surfaces, cyan for telemetry, emerald for *in*, amber for *out*. The colour, type and spacing tokens in `frontend/tailwind.config.js` come straight from its `DESIGN.md`, so class names like `bg-surface-container` and `text-secondary` match the mockups.

Inter, JetBrains Mono and the Material Symbols icons are installed from npm and served by the app itself. Nothing loads from Google, so it works on a PG network with no internet.

A few things in the mockups were left out because the register has no real data behind them: curfew and compliance, capacity ("20 / 20 Max"), floor names, guardian contacts, the gate buzzer and emergency lock, "neural weights" and AES-256 claims, PDF export, profile editing, and guest photos. The register never stores a photograph, so avatars are initials. Match scores are raw cosine similarity (`0.62`), not percentages, because "98.4%" would suggest a certainty the number doesn't have.

**Manual override** is a dialog you can open from the header, a guest's page, the dashboard drawer, or `/log`. It can back-date an entry to earlier today, but never before the 4am rollover and never into the future. The API enforces the same rule: `POST /api/logs` returns 400 for an unparsable or future `timestamp`.

---

## Bringing it up in stages

Each stage can be tested on its own. Don't move on until the one before it works.

### 1. Register logic

```bash
npm test
```

### 2. API and dashboard

```bash
npm run seed
npm run dev:api
npm run dev:ui      # in another terminal
```

You should have a working register on fake data, manual entry included. Delete `data/*.json` before enrolling anyone real.

### 3. Enrollment

```bash
pip install -r recognition/requirements.txt
cd recognition
python3 enroll.py --name "Asha Kulkarni" --room 204 \
    --photos photos/asha/*.jpg --consent-given
python3 enroll.py --list
```

Good reference photos: 3-5 per guest, taken on a phone at arm's length in indoor light. Add one with glasses and one without if they wear them, and one with the head slightly turned.

`enroll.py` rejects photos with no face, more than one face, a face under 110px, or visible blur. It also warns if one photo looks like a different person from the rest.

### 4. Recognition, against a recording first

Stand at the door and film thirty seconds of people walking in and out, then:

```bash
cd recognition
python3 service.py --source clip.mp4 --no-post --window
```

It prints what it *would* have logged. Get names and directions right on the recording before pointing it at the live register, then drop `--no-post`.

`--window` (older name: `--preview`) needs a display and the non-headless OpenCV build. On a headless mini PC, skip it and read the log lines, or open the dashboard's **At the Door** page, which needs neither.

---

## Adding a guest from the dashboard

Open **Add a guest**, enter a name and room, pick 3-8 photos, tick the consent box and press the button. What happens behind it:

- Photos are shrunk to 1600px in the browser before upload. A phone photo is several megabytes, and the recogniser only wants a face over 110px. iPhone rotation flags are respected, otherwise portrait shots arrive sideways and the face is missed.
- The backend writes them to a scratch directory, runs `enroll.py --json`, and deletes them as soon as the job ends, pass or fail. Only the embedding survives.
- Loading the model takes tens of seconds (minutes on the very first run while the model pack downloads), so this is a job the page polls rather than a request that hangs.
- The recognition service picks up the new guest within `GALLERY_POLL_SECONDS`. No restart, no terminal.
- HEIC photos get a clear message about what to do, since an iPhone on default settings is the most likely way this goes wrong.

`enroll.py` still works from the command line exactly as before.

### Removing guests

On **Guest List**, press and hold a guest (or tap **Select**), tick as many as you like and press **Remove**. Their face data is deleted and they come off the list. Their past movements stay in the register.

From a terminal:

```bash
python3 enroll.py --keep-record --remove <id> <id> ...
```

---

## Two cameras

```
   outside                       PG door                       inside
                                    │
  Cam 2  ◄── people leaving walk    │    people arriving walk ──►  Cam 1
 "outside camera"   toward it       │    toward it            "entrance camera"
   marks OUT                        │                            marks IN
```

- **Cam 1, the entrance camera,** faces the door from inside. Every enrolled guest it recognises is logged **in**.
- **Cam 2, the outside camera,** looks back at the door from the far side. Every enrolled guest it recognises is logged **out**.
- Direction comes from *which camera* saw the face, not from guessing whether the face box is growing. Someone who stops at the door or walks in at an angle is still logged correctly.
- Every movement records its camera (`camera: "1"` or `"2"` in `logs.json`).

**Swap cameras** on the At the Door page trades the two jobs. Use it if the cameras ended up plugged in or mounted the other way round. It's saved, takes effect within a few seconds, and needs no restart or `.env` edit. A walk-past that was half-finished at the moment of the swap is dropped, not logged under the wrong job.

**One person, two cameras.** If the views overlap, the second camera ignores a guest the first one just logged, for `CROSS_CAMERA_SECONDS` (8). Without this, someone stepping through the door could show up as "in" and then "out" a second later. The same camera is protected by the normal cooldown.

### Where to mount them

A face is only recognised when it points at the lens, so each camera has to sit where the people it's meant to log are walking *toward* it. Arrivals walk toward the entrance camera. Leavers have to walk toward the outside camera, so it goes on the far side of the door looking back at it. A camera that just faces outward sees arrivals face-on and will log them as leaving.

If arrivals show up as exits (or the reverse), the cameras are swapped or aimed wrong. Press **Swap cameras**, or re-aim them.

### Laptop camera plus an external webcam

1. Plug the webcam in, then find the camera numbers:
   ```bash
   cd recognition
   python3 list_cameras.py            # lists what answers
   python3 list_cameras.py --show     # opens each camera, numbered
   ```
   `--show` needs the non-headless build (`pip install opencv-python`). The built-in camera is usually `0` and the webcam `1`.
2. Put them in `recognition/.env`:
   ```
   CAMERA_1_SOURCE=0
   CAMERA_2_SOURCE=1
   ```
3. Run `python3 service.py`. The log says which camera has which job. Open **At the Door** and you should see both pictures, Cam 1 on the left, each labelled with its job.
4. If the left picture is actually the one outside, don't edit a file. Press **Swap cameras**.

Good to know:

- **The service starts with one camera if the other is missing.** It notices a webcam plugged in later within `CAMERA_RETRY_SECONDS` (10). No restart.
- **Only one program can use a camera at a time.** If a camera "has nothing there", close Teams, Zoom, the Windows Camera app and any browser tab using it.
- **Two cameras means twice the work.** If the laptop struggles, set `CAMERA_WIDTH=1280` and `CAMERA_HEIGHT=720` (a doorway doesn't need 1080p), then lower `MAX_FPS`. The log prints frames per second for each camera.
- **Dry run with two recordings:**
  ```bash
  python3 service.py --source in.mp4 --source2 out.mp4 --no-post --window
  ```
  `--source` plays the entrance camera, `--source2` the outside one.
- **Back to one camera:** delete the two `CAMERA_n_SOURCE` lines and set `CAMERA_SOURCE` instead.

---

## What it costs the mini PC

Face detection is the expensive part: roughly 100ms a frame on an N100, which is most of a core if it runs on every frame. The original loop did exactly that, all day, whether or not anyone was at the door. Two changes fix it, and neither needs the warden to remember anything.

**The motion gate.** Each frame is compared to the previous one on an 80px-wide thumbnail before it reaches the detector. No movement, no detection. A doorway is empty almost all day, so most frames stop there, costing microseconds instead of 100ms.

Movement wakes the detector instantly. It keeps looking for 1.5 seconds afterwards so someone who stops dead at the door is still seen, and it sweeps every couple of seconds regardless so a person standing perfectly still can't hide.

`test_service.py` plays a corridor through the real loop and counts. A clip that's about 4% occupied needs **80% fewer detections** with the gate on and produces byte-identical register entries. A real doorway is idle far more than 96% of the time, so expect better. The service prints the share of skipped frames every 300 frames. That's the number to watch.

**The live view only runs while someone's watching.** The recognition service asks the backend whether a browser has requested a frame in the last ten seconds. If not, it doesn't encode anything. Close the tab, switch pages, or let the phone screen sleep and the cost disappears within seconds. The switch on the door screen is the manual version, for when the screen has to stay up but the box is busy.

The switch does *not* affect detection or the register. It only saves the JPEG encode and the network, which is real but small (single-digit percent). The motion gate is where the big saving is. If the box still struggles with the gate on, the next levers are, in order: `MAX_FPS`, then `MODEL_PACK=buffalo_s`, then `DETECT_WIDTH`.

---

## Outpasses and parent approval

**Outpass** in the top bar (or **Issue Outpass** on a guest's page): pick the student, confirm the parent's email, choose a reason and leaving time, and press *Issue outpass and email parent*. The parent gets an email with the student, destination, reason, leaving and expected return times, and the pass number. The address is remembered for next time.

- One open pass per student. **Mark returned** or **Cancel** closes it. A pass past its expected return time shows **Overdue**.
- **Print** opens a slip the student can show at the gate. **Resend email** retries.
- If the email can't be sent, the pass is still issued and the page says why.
- Data lives in `data/outpasses.json` and `data/parents.json`, written by the backend only.

### Email setup

In `backend/.env`, then `cd backend && npm install` and restart the API:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=<16-letter App Password>
PG_CONTACT=+91 98xxxxxxx
```

Gmail needs an **App Password** (Google Account → Security → 2-Step Verification → App passwords). Your normal password will be refused.

With `SMTP_HOST` empty, nothing is sent. Each email is saved as a text file in `data/outbox/` instead, which is the safe way to try it out.

### Approve / Decline

The email has two buttons. Each opens a small page showing the request with one confirm button. The extra tap is deliberate: mail scanners open every link, so a link that decided on open would answer before the parent had read anything.

The answer appears on the Outpass page within a few seconds:

- **Awaiting parent** becomes **Approved** (print the slip, let them go) or **Declined by parent**, with their reason if they gave one. A declined pass closes and the student can be re-requested.
- The first answer is final. Buttons stop working after `APPROVAL_TTL_HOURS` (72), or once you cancel or close the pass. **Resend request** sends the same email with a fresh window.
- The printed slip says APPROVED, DECLINED or Awaiting, never more than the parent said.

**Security.** Each pass has a private random token that exists only in that parent's email and is never returned by the dashboard API. The approval pages run on their own port (`PUBLIC_PORT`, 4001) in a separate app that can reach nothing else: no roster, no log, no other pass. Wrong ids and wrong tokens get the same generic page.

### Letting parents reach the approval page

A parent's phone can't open `http://localhost:4001`. For real use, give port **4001** a public address, and only 4001, never 4000, which lists every student. Then set `PUBLIC_URL=https://...` in `backend/.env` and restart.

The easiest free option is a Cloudflare quick tunnel:

```
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:4001
```

It prints an address like `https://something.trycloudflare.com`. Quick-tunnel addresses change every time you start one, and old emails stop working when they do. For a fixed address use a named Cloudflare tunnel or any host that can forward to port 4001.

Until `PUBLIC_URL` is set, the Outpass page shows a warning and the buttons only work on the computer running the register.

---

## API

| Method | Path | Used by |
|---|---|---|
| GET | `/api/health` | anything checking the box is up |
| GET | `/api/summary` | register header, service-health dot |
| GET | `/api/guests` | guest list, manual-entry picker |
| GET | `/api/guests/:id` | guest detail |
| POST | `/api/guests/remove` | multi-select on the guest list, `{ ids: [...] }`. Deletes face data, keeps visit history. Token |
| GET | `/api/logs` | register, guest detail. `?date= &guest_id= &limit=` |
| POST | `/api/logs` | recognition service, manual entry (optional validated `timestamp`). Token |
| POST | `/api/unknown` | recognition service. Token |
| GET | `/api/unknown` | unknown faces page |
| GET | `/api/outpasses` | newest first. `?status=issued`, `?guest_id=` |
| POST | `/api/outpasses` | issue an outpass and email the parent. Token |
| POST | `/api/outpasses/:id/resend` | send the email again. Token |
| POST | `/api/outpasses/:id/close` | `{ status: "returned" \| "cancelled" }`. Token |
| GET/POST | `/api/parents/:guest_id` | saved parent contact (POST needs the token) |
| GET/POST | `/outpass/respond` | **public port 4001 only.** GET shows the page, POST decides, authorised by the pass token |
| POST | `/api/preview` | recognition service sends a door frame (`cam` says which). Token |
| GET | `/api/preview?cam=1\|2` | the door screen. Asking is what keeps that camera's feed alive |
| GET | `/api/preview/state?cam=1\|2` | recognition service asking whether to bother |
| POST | `/api/preview/state` | the live view switch (both cameras). Token |
| GET | `/api/cameras` | which camera is entrance and which is outside |
| POST | `/api/cameras` | the Swap button, `{ swapped: true \| false }`. Token |
| POST | `/api/enroll` | Add a guest form. Token |
| GET | `/api/enroll/:jobId` | polling the enrollment job |

`embeddings.json` has no route. The API never reads it.

> **A note on `GET /api/preview`.** It's open, like every other GET here. That's consistent: the roster, the movements and the guest history are open too, and the whole API is meant to live on a trusted LAN behind `CORS_ORIGIN`. But a live picture of your doorway is more sensitive than a list of room numbers. If the PG wifi is shared with guests, put the token on the GETs too, or keep the dashboard on a separate network.

---

## How it decides things

### Direction with one camera

With a single camera there's no "which camera" to go on. The first plan toggled each guest's state on every sighting, which works until one recognition is missed. After that, every entry for that guest is inverted, permanently and silently.

Two changes deal with it. The service tracks each face across frames and reads direction from whether the box is growing (walking toward the camera) or shrinking. When that read is confident it's sent as `direction`. When it isn't, `direction` is null and the backend falls back to toggling. Also, the register rolls over at 4am (`DAY_RESET_HOUR`), when everyone is home, so any drift lasts a day at most instead of building up for weeks.

Set `APPROACH_MEANS=out` if your single camera watches people leaving rather than arriving. With two cameras none of this applies.

### Liveness is opt-in

KAVACH's liveness check is challenge-based: it wants the subject to blink or turn on cue. That doesn't work for someone walking past without stopping.

What's wired in instead (`core.check_liveness`) is a coarse passive filter. It rejects a match whose best frame is too blurry, has flat chroma (a screen replay) or too much glare (a print or screen catching the light), and logs it to `/api/unknown` with a `liveness_*` reason.

It is not a real anti-spoofing model and won't catch a good print or a high-end replay. The attack it covers, holding up a printed photo of a housemate to fake a sign-in, is narrow for a PG, and the filter costs a colour crop per observation plus some false rejections. So it's off by default.

To try it, set `LIVENESS_ENABLED=1` and tune `LIVENESS_BLUR_FLOOR`, `LIVENESS_CHROMA_LOW` / `LIVENESS_CHROMA_HIGH` and `LIVENESS_GLARE_CEILING` in `recognition/.env` against your own camera's footage. The defaults are starting points, same as `MATCH_THRESHOLD`.

---

## Tuning

`MATCH_THRESHOLD` (0.42) is the cosine similarity floor. `MATCH_MARGIN` (0.06) is how far the best guest must beat the runner-up. Both are starting points. Tune them on your own faces, not on numbers from a blog post.

The way to do it: run for a week with `LOG_UNKNOWNS=1` and watch the unknown faces page (or `GET /api/unknown`).

- Lots of rejections just above the threshold means real guests are being missed. Lower it, or re-enroll those guests with better photos.
- Wrong names in the register means the opposite. Raise the threshold and widen the margin.

Missing a guest is cheap. Putting the wrong name in the register is not. When in doubt, err high.

The unknown faces page shades near-misses against `VITE_MATCH_THRESHOLD`. That's display only. The real threshold belongs to the recognition service, so keep the two in step.

---

## If the door screen stays blank

`recognition/service.py` reads `recognition/.env` on start (real environment variables still win). The log line `read N settings from .env` confirms the file was found.

If you see `the register rejected our SERVICE_TOKEN`, the token in `recognition/.env` doesn't match `backend/.env`. Fix it and restart both. Movements queue on disk in the meantime instead of being dropped.

---

## Hardware and consent

**Camera.** A face needs roughly 80-100 pixels across where people walk past. A 1080p camera covering a 1.2m doorway from 2-3m is about right. It also has to cope with backlight: a camera inside pointing at a bright doorway will silhouette everyone who walks in, and that alone can sink the whole thing. For an IP camera, set `CAMERA_SOURCE` to its RTSP URL. For USB, use the index.

**Why not `dlib` / `face_recognition`.** The stack is InsightFace on ONNX Runtime, which pip-installs on the mini PC without a compiler. `dlib` needs a C++ toolchain and cmake, and its model is noticeably weaker on the off-angle, motion-blurred frames a doorway produces. If you do need `face_recognition` for another reason, only the embedding call in `core.py` has to change. The matching interface stays the same.

**Why not OpenVINO (yet).** Twenty faces on CPU isn't the bottleneck, detection is. Get it running on plain `onnxruntime` first and watch the fps the service logs every 300 frames. Only if that's under about 6 fps, switch to `onnxruntime-openvino` or drop `MODEL_PACK` to `buffalo_s`. Adding OpenVINO up front just means debugging two things at once.

**Consent.** `enroll.py` refuses to run without `--consent-given`, and `--remove` deletes a guest's face data when they move out. Face embeddings of twenty residents are biometric data under the DPDP Act. Get written consent at move-in and keep it with the tenancy paperwork. Decide this now, not after twenty people are enrolled.

---

## Where this came from

K.A.V.A.C.H is an identity-document forgery detection project (React/Vite/Tailwind on the front, Node/Express on the back). This register reuses its scaffold and store, and swaps the document-analysis flow for face recognition at a door.
