/**
 * PG register API.
 *
 * Keeps K.A.V.A.C.H's Express + CORS + JSON scaffold and REST conventions.
 * Removed with the document-forgery flow: gemini.js and the
 * /api/analyze-document, /api/verify-face and /api/upload routes, along with
 * multer and every upload path — nothing is uploaded to this server any more.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const db = require('./db');
const liveView = require('./live-view');
const cameras = require('./cameras');
const enrollJobs = require('./enroll-jobs');
const guestRemoval = require('./guest-removal');
const outpass = require('./outpass');
const { createPublicApp } = require('./public-server');

const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_PORT = process.env.PUBLIC_PORT || 4001;

/**
 * Shared secret for the recognition service. Optional, but set it: without
 * it anyone on the LAN can POST movements into the register.
 */
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';

/** Clock drift allowed between whoever sends a movement and this machine. */
const FUTURE_SKEW_MS = 10 * 60 * 1000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

/**
 * Body limits, per route rather than global.
 *
 * Everything the register does fits in a few hundred bytes. Two things don't:
 * a camera frame for the live view, and a handful of enrollment photos. Those
 * get their own parsers so one generous limit doesn't apply to routes that
 * have no business receiving a megabyte.
 */
const smallJson = express.json({ limit: '64kb' });
const frameJson = express.json({ limit: '4mb' });
const photosJson = express.json({ limit: '48mb' });
const BIG_ROUTES = new Set(['/api/preview', '/api/enroll']);

app.use((req, res, next) => (BIG_ROUTES.has(req.path) ? next() : smallJson(req, res, next)));

/**
 * Request log. Frames are excluded: the live view posts several a second, and
 * a log that scrolls that fast is a log nobody can read when something breaks.
 */
app.use((req, _res, next) => {
  if (req.method !== 'GET' && req.path !== '/api/preview') {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

function requireServiceToken(req, res, next) {
  if (!SERVICE_TOKEN) return next();
  if (req.get('X-Service-Token') === SERVICE_TOKEN) return next();
  return res.status(401).json({ error: 'invalid service token' });
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    if (err.code === 'UNKNOWN_GUEST') return res.status(404).json({ error: err.message });
    if (err.code === 'BAD_DATE') return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
};

// --------------------------------------------------------------------------
// Health + summary
// --------------------------------------------------------------------------

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    data_dir: db.DATA_DIR,
    day_reset_hour: db.DAY_RESET_HOUR,
    // False means the Approve / Decline buttons in emails only work on this computer.
    public_url_set: Boolean(process.env.PUBLIC_URL),
  })
);

app.get('/api/summary', wrap((_req, res) => res.json(db.summary())));

// --------------------------------------------------------------------------
// Guests
// --------------------------------------------------------------------------

/** Roster with current status and last-seen time. Never includes embeddings. */
app.get('/api/guests', wrap((_req, res) => res.json(db.guestsWithStatus())));

app.get('/api/guests/:id', wrap((req, res) => {
  const guest = db.guestDetail(req.params.id);
  if (!guest) return res.status(404).json({ error: 'guest not found' });
  return res.json(guest);
}));

/**
 * Remove several guests at once: { ids: [...] }. Deletes their face data and
 * takes them off the roster; their visit history is kept. Needs the token
 * because it is destructive.
 */
app.post('/api/guests/remove', requireServiceToken, (req, res) => {
  const checked = guestRemoval.validate(req.body);
  if (checked.error) {
    return res.status(checked.status).json({ error: checked.error, code: checked.code });
  }
  return guestRemoval
    .remove(checked.ids, { isBusy: enrollJobs.isBusy })
    .then((result) => {
      if (result.error) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }
      return res.json(result);
    })
    .catch((err) => {
      console.error(err);
      return res.status(500).json({ error: 'internal error' });
    });
});

// --------------------------------------------------------------------------
// Outpasses
//
// Issuing one emails the parent. Everything that changes anything needs the
// token. Only GET and POST are used, like the rest of this API.
// --------------------------------------------------------------------------

const sendResult = (res, result) => {
  if (result.error) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.json(result);
};

const crash = (res) => (err) => {
  console.error(err);
  return res.status(500).json({ error: 'internal error' });
};

app.get('/api/outpasses', wrap((req, res) => res.json(outpass.list({
  status: req.query.status || null,
  guest_id: req.query.guest_id || null,
  limit: req.query.limit,
}))));

app.post('/api/outpasses', requireServiceToken, (req, res) =>
  outpass.create(req.body).then((r) => sendResult(res, r)).catch(crash(res)));

app.post('/api/outpasses/:id/resend', requireServiceToken, (req, res) =>
  outpass.resend(req.params.id).then((r) => sendResult(res, r)).catch(crash(res)));

app.post('/api/outpasses/:id/close', requireServiceToken, wrap((req, res) =>
  sendResult(res, outpass.close(req.params.id, req.body && req.body.status))));

/** Saved parent contact for a student, so the form can fill itself in. */
app.get('/api/parents/:guest_id', wrap((req, res) => res.json(outpass.getParent(req.params.guest_id))));

app.post('/api/parents/:guest_id', requireServiceToken, wrap((req, res) =>
  sendResult(res, outpass.saveParent(req.params.guest_id, req.body))));

// --------------------------------------------------------------------------
// Movements
// --------------------------------------------------------------------------

/**
 * Record a movement.
 *
 * From the recognition service: { event_id, guest_id, timestamp, confidence,
 * direction }. `direction` may be null, meaning the camera could not read the
 * walking direction — the store then toggles the guest's last known state.
 *
 * From the dashboard's manual override: { guest_id, direction, source:
 * "manual" }, which requires an explicit direction.
 */
app.post('/api/logs', requireServiceToken, wrap((req, res) => {
  const { guest_id, timestamp, confidence, direction, source, event_id, note, camera } = req.body || {};

  if (!guest_id) return res.status(400).json({ error: 'guest_id is required' });
  if (direction != null && !['in', 'out'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "in", "out" or null' });
  }
  if (source === 'manual' && !direction) {
    return res.status(400).json({ error: 'a manual entry must say "in" or "out"' });
  }

  // A timestamp that doesn't parse would be written to the register as-is and
  // poison every sort and every in/out calculation after it. One in the
  // future would pin a guest's state until that moment arrives. The dashboard
  // sends one for "earlier today" manual entries, so check it here rather
  // than trusting every caller. Stored normalised, so the file only ever
  // holds one date format.
  let stamp = null;
  if (timestamp != null && timestamp !== '') {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'timestamp must be an ISO date-time' });
    }
    if (parsed.getTime() > Date.now() + FUTURE_SKEW_MS) {
      return res.status(400).json({ error: 'timestamp is in the future' });
    }
    stamp = parsed.toISOString();
  }

  const { log, duplicate } = db.appendLog({
    guest_id,
    timestamp: stamp,
    confidence,
    direction: direction ?? null,
    source: source || 'camera',
    event_id: event_id || null,
    note: note || '',
    camera: camera == null ? null : String(camera),
  });

  // 200 rather than 201 on a replay, so the service can tell them apart.
  return res.status(duplicate ? 200 : 201).json({ log, duplicate });
}));

/** Full visit history. ?date=YYYY-MM-DD &guest_id= &limit= */
app.get('/api/logs', wrap((req, res) => {
  const { date, guest_id, limit } = req.query;
  return res.json(db.queryLogs({ date, guest_id, limit }));
}));

// --------------------------------------------------------------------------
// Live door view — one picture per camera
// --------------------------------------------------------------------------

/**
 * `cam` is the physical camera, '1' or '2'. Left out, it means '1', which is
 * what a single-camera setup has always sent.
 */
function viewFor(raw) {
  const id = raw == null || raw === '' ? '1' : String(raw);
  return liveView.forCamera(id);
}

const badCamera = (res) => res.status(400).json({ error: 'cam must be 1 or 2' });

/**
 * A frame from the recognition service. Held in memory only, and only while
 * somebody is looking: the reply tells the service whether to send another.
 */
app.post('/api/preview', frameJson, requireServiceToken, wrap((req, res) => {
  const view = viewFor((req.body || {}).cam);
  if (!view) return badCamera(res);
  const result = view.put(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true, wanted: result.wanted });
}));

/** The browser's poll, per camera. Asking is what keeps that camera's feed alive. */
app.get('/api/preview', wrap((req, res) => {
  const view = viewFor(req.query.cam);
  if (!view) return badCamera(res);
  return res.json(view.take());
}));

/** The recognition service's poll. Deliberately does not count as watching. */
app.get('/api/preview/state', wrap((req, res) => {
  const view = viewFor(req.query.cam);
  if (!view) return badCamera(res);
  return res.json(view.state());
}));

/** The warden's switch. Covers both cameras. */
app.post('/api/preview/state', requireServiceToken, wrap((req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  return res.json(liveView.setEnabledAll(enabled));
}));

// --------------------------------------------------------------------------
// Which camera watches which side of the door
// --------------------------------------------------------------------------

/**
 * Cam 1 is the entrance camera and Cam 2 the outside camera, unless swapped.
 * The recognition service reads this to decide whether a face on each camera
 * means "in" or "out".
 */
app.get('/api/cameras', wrap((_req, res) => res.json(cameras.get())));

/** The Swap button. { swapped: true|false }; needs the token. */
app.post('/api/cameras', requireServiceToken, wrap((req, res) => {
  const { swapped } = req.body || {};
  if (typeof swapped !== 'boolean') {
    return res.status(400).json({ error: 'swapped must be true or false' });
  }
  const state = cameras.setSwapped(swapped);
  console.log(`cameras ${state.swapped ? 'swapped' : 'back to default'}: ${state.cameras.map((c) => `cam ${c.id} = ${c.role}`).join(', ')}`);
  return res.json(state);
}));

// --------------------------------------------------------------------------
// Adding a guest
// --------------------------------------------------------------------------

/**
 * Enrollment from the browser. Starts a job and returns immediately — the
 * model load alone takes tens of seconds on a mini PC, and minutes the first
 * time. The page polls the job below.
 */
app.post('/api/enroll', photosJson, requireServiceToken, wrap((req, res) => {
  const result = enrollJobs.start(req.body || {});
  if (result.error) {
    return res.status(result.code === 'busy' ? 409 : 400)
      .json({ error: result.error, code: result.code });
  }
  return res.status(202).json(result.job);
}));

app.get('/api/enroll/:jobId', wrap((req, res) => {
  const job = enrollJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'that enrollment has expired' });
  return res.json(job);
}));

// --------------------------------------------------------------------------
// Unknown faces
// --------------------------------------------------------------------------

/**
 * Faces the matcher rejected. Kept out of the register, but worth keeping:
 * a rise here usually means the threshold needs loosening or a guest needs
 * re-enrolling, not that strangers are streaming through the door.
 */
app.post('/api/unknown', requireServiceToken, wrap((req, res) => {
  const { row, duplicate } = db.appendUnknown(req.body || {});
  return res.status(duplicate ? 200 : 201).json({ row, duplicate });
}));

app.get('/api/unknown', wrap((req, res) => res.json(db.queryUnknown({ limit: req.query.limit || 100 }))));

// --------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

/**
 * Body-parser failures, in JSON.
 *
 * Express's default is an HTML error page, which the dashboard then fails to
 * parse and reports as a network fault. A warden who picked eight 12MP photos
 * should be told that, not shown "Unexpected token <".
 */
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Those photos add up to too much. Try fewer of them, or smaller ones.',
      code: 'too_large',
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'That request could not be read.', code: 'bad_body' });
  }
  console.error(err);
  return res.status(500).json({ error: 'internal error' });
});

// Approval pages for parents. Separate port, separate app: see public-server.js.
const publicApp = createPublicApp(express);

if (require.main === module) {
  publicApp
    .listen(PUBLIC_PORT, () => {
      console.log(`parent approval pages on port ${PUBLIC_PORT}${process.env.PUBLIC_URL ? ` (emails link to ${process.env.PUBLIC_URL})` : ' (PUBLIC_URL unset: email buttons only work on this computer)'}`);
    })
    .on('error', (err) => {
      console.error(`could not open the approval port ${PUBLIC_PORT}: ${err.message}. Outpasses still work; parents cannot answer by email.`);
    });

  app.listen(PORT, () => {
    console.log(`PG register API on http://localhost:${PORT}`);
    console.log(`data: ${db.DATA_DIR}  |  day resets at ${db.DAY_RESET_HOUR}:00`);
    if (!SERVICE_TOKEN) console.warn('SERVICE_TOKEN is unset — anyone on the LAN can post movements');
  });
}

module.exports = app;
