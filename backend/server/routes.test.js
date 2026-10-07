/**
 * Route contract tests for index.js.
 *
 * Stubs the sliver of express the server actually uses (get/post/use,
 * req.body, req.query, res.status/json) and drives the real handlers from
 * index.js. The stub is always used, whether or not express is installed.
 *
 *   node backend/server/routes.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --------------------------------------------------------------------------
// express / cors stub
// --------------------------------------------------------------------------

function makeApp() {
  const routes = { GET: [], POST: [] };
  const middleware = [];

  const register = (method) => (routePath, ...handlers) => {
    routes[method].push({ routePath, handlers });
  };

  const app = {
    routes,
    middleware,
    get: register('GET'),
    post: register('POST'),
    use: (fn) => middleware.push(fn),
    listen: () => {},
  };
  return app;
}

function matchRoute(routePath, actual) {
  const a = routePath.split('/');
  const b = actual.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** Drive one request through the real handler chain. */
function request(app, method, url, { body = {}, headers = {} } = {}) {
  const [rawPath, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));

  const req = {
    method,
    path: rawPath,
    body,
    query,
    params: {},
    get: (h) => headers[h] ?? headers[h.toLowerCase()],
  };

  const out = { status: 200, body: null, html: null, headers: {} };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
    set(h) {
      Object.assign(out.headers, h);
      return this;
    },
    send(html) {
      out.html = html;
      return this;
    },
  };

  for (const mw of app.middleware) {
    if (mw.length === 3) mw(req, res, () => {});
  }

  for (const route of app.routes[method]) {
    const params = matchRoute(route.routePath, rawPath);
    if (!params) continue;
    req.params = params;
    let i = 0;
    const next = () => {
      const h = route.handlers[i];
      i += 1;
      if (h) h(req, res, next);
    };
    next();
    return out;
  }

  // fall through to the 404 middleware registered with app.use(handler)
  const notFound = app.middleware.find((m) => m.length === 2);
  if (notFound) notFound(req, res);
  return out;
}

// --------------------------------------------------------------------------
// Install the stub, then load the real server
// --------------------------------------------------------------------------

let app;
let publicApp;
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

// Always the stub, even when express is installed. The tests drive handlers
// directly through request() below, which needs the stub's `app` object; real
// express has no equivalent, and the old "use it if present" branch left `app`
// undefined, so every test failed as soon as `npm install` had been run.
Module._load = function patched(requested, parent, isMain) {
  if (requested === 'express') {
    // The first app is the dashboard API; the second is the parent approval app.
    const express = () => {
      const made = makeApp();
      if (!app) app = made;
      else publicApp = made;
      return made;
    };
    express.json = () => (req, _res, next) => next && next();
    express.urlencoded = express.json;
    return express;
  }
  if (requested === 'cors') return () => (req, _res, next) => next && next();
  return origLoad.apply(this, [requested, parent, isMain]);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-routes-'));
process.env.DATA_DIR = tmp;
process.env.DAY_RESET_HOUR = '4';
process.env.SERVICE_TOKEN = 'secret123';

require('./index');
Module._load = origLoad;
Module._resolveFilename = origResolve;

const GUESTS = [
  { id: 'g1', name: 'Asha Kulkarni', room_no: '204' },
  { id: 'g2', name: 'Rohit Deshmukh', room_no: '101' },
];

let passed = 0;
let failed = 0;
const AUTH = { headers: { 'X-Service-Token': 'secret123' } };

function test(name, fn) {
  fs.writeFileSync(path.join(tmp, 'guests.json'), JSON.stringify(GUESTS));
  fs.writeFileSync(path.join(tmp, 'logs.json'), '[]');
  fs.writeFileSync(path.join(tmp, 'unknown.json'), '[]');
  try {
    fn();
    passed += 1;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const GET = (url) => request(app, 'GET', url);
const POST = (url, body, opts = AUTH) => request(app, 'POST', url, { body, ...opts });
const PGET = (url) => request(publicApp, 'GET', url);
const PPOST = (url, body) => request(publicApp, 'POST', url, { body });

// --------------------------------------------------------------------------

test('GET /api/health reports config', () => {
  const r = GET('/api/health');
  eq(r.status, 200);
  eq(r.body.ok, true);
  eq(r.body.day_reset_hour, 4);
});

test('GET /api/guests returns the roster with status and no biometrics', () => {
  const r = GET('/api/guests');
  eq(r.status, 200);
  eq(r.body.length, 2);
  eq(r.body[0].room_no, '101');
  eq(r.body[0].status, 'in');
  eq('embeddings' in r.body[0], false);
});

test('GET /api/guests/:id returns history, 404s when missing', () => {
  POST('/api/logs', { guest_id: 'g1', direction: 'out' });
  const r = GET('/api/guests/g1');
  eq(r.status, 200);
  eq(r.body.name, 'Asha Kulkarni');
  eq(r.body.logs.length, 1);
  eq(GET('/api/guests/nope').status, 404);
});

test('POST /api/logs creates a movement', () => {
  const r = POST('/api/logs', { guest_id: 'g1', confidence: 0.58, event_id: 'e1' });
  eq(r.status, 201);
  eq(r.body.log.direction, 'out');
  eq(r.body.duplicate, false);
});

test('POST /api/logs is idempotent on event_id', () => {
  POST('/api/logs', { guest_id: 'g1', event_id: 'e1' });
  const again = POST('/api/logs', { guest_id: 'g1', event_id: 'e1' });
  eq(again.status, 200, 'replay returns 200, not 201');
  eq(again.body.duplicate, true);
  eq(GET('/api/logs').body.length, 1);
});

test('POST /api/logs rejects a missing guest_id', () => {
  eq(POST('/api/logs', {}).status, 400);
});

test('POST /api/logs rejects a nonsense direction', () => {
  const r = POST('/api/logs', { guest_id: 'g1', direction: 'sideways' });
  eq(r.status, 400);
});

test('POST /api/logs rejects a timestamp that is not a date', () => {
  const r = POST('/api/logs', { guest_id: 'g1', direction: 'out', source: 'manual', timestamp: 'garbage' });
  eq(r.status, 400);
  eq(GET('/api/logs').body.length, 0, 'nothing should have been written');
});

test('POST /api/logs rejects a timestamp in the future', () => {
  const later = new Date(Date.now() + 3600e3).toISOString();
  const r = POST('/api/logs', { guest_id: 'g1', direction: 'out', source: 'manual', timestamp: later });
  eq(r.status, 400);
  eq(GET('/api/logs').body.length, 0);
});

test('POST /api/logs stores a backdated manual entry, normalised to ISO', () => {
  const earlier = new Date(Date.now() - 600e3);
  const r = POST('/api/logs', {
    guest_id: 'g1', direction: 'out', source: 'manual', note: 'Face obstructed / mask', timestamp: earlier.toString(),
  });
  eq(r.status, 201);
  eq(r.body.log.timestamp, new Date(earlier.toString()).toISOString());
  eq(r.body.log.source, 'manual');
  eq(r.body.log.note, 'Face obstructed / mask');
});

test('POST /api/logs rejects a manual entry with no direction', () => {
  const r = POST('/api/logs', { guest_id: 'g1', source: 'manual' });
  eq(r.status, 400);
});

test('POST /api/logs 404s on an unknown guest', () => {
  eq(POST('/api/logs', { guest_id: 'ghost' }).status, 404);
});

test('POST /api/logs needs the service token', () => {
  const r = POST('/api/logs', { guest_id: 'g1' }, { headers: {} });
  eq(r.status, 401);
  eq(GET('/api/logs').body.length, 0, 'nothing written on a rejected request');
});

test('GET /api/logs filters by guest and rejects a bad date', () => {
  POST('/api/logs', { guest_id: 'g1' });
  POST('/api/logs', { guest_id: 'g2' });
  eq(GET('/api/logs').body.length, 2);
  eq(GET('/api/logs?guest_id=g1').body.length, 1);
  eq(GET('/api/logs?limit=1').body.length, 1);
  eq(GET('/api/logs?date=tuesday').status, 400);
});

test('GET /api/summary counts in and out', () => {
  POST('/api/logs', { guest_id: 'g1', direction: 'out' });
  const s = GET('/api/summary').body;
  eq(s.total_guests, 2);
  eq(s.currently_out, 1);
  eq(s.currently_in, 1);
  eq(s.movements_today, 1);
});

test('unknown faces post separately and stay out of the register', () => {
  const r = POST('/api/unknown', { event_id: 'u1', best_score: 0.3, reason: 'below_threshold' });
  eq(r.status, 201);
  eq(GET('/api/unknown').body.length, 1);
  eq(GET('/api/logs').body.length, 0);
});

test('POST /api/guests/remove needs the token and a sensible list of ids', () => {
  eq(POST('/api/guests/remove', { ids: ['g1'] }, { headers: {} }).status, 401);
  eq(POST('/api/guests/remove', {}).status, 400, 'no ids');
  eq(POST('/api/guests/remove', { ids: [] }).status, 400, 'empty list');
  eq(POST('/api/guests/remove', { ids: ['--keep-record'] }).status, 400, 'flag-shaped id');
  eq(POST('/api/guests/remove', { ids: [42] }).status, 400, 'not a string');
  eq(POST('/api/guests/remove', { ids: Array.from({ length: 201 }, (_, i) => `g${i}`) }).status, 400, 'too many');
});

test('outpass endpoints need the token, and bad input is refused before anything is sent', () => {
  eq(POST('/api/outpasses', { guest_id: 'g1' }, { headers: {} }).status, 401);
  eq(POST('/api/outpasses/OP-1/resend', {}, { headers: {} }).status, 401);
  eq(POST('/api/outpasses/OP-1/close', { status: 'returned' }, { headers: {} }).status, 401);
  eq(POST('/api/parents/g1', { parent_email: 'a@b.com' }, { headers: {} }).status, 401);
  eq(POST('/api/outpasses/OP-1/close', { status: 'deleted' }).status, 400);
  eq(POST('/api/outpasses/OP-404/close', { status: 'returned' }).status, 404);
  eq(POST('/api/parents/g1', { parent_email: 'nope' }).status, 400);
  eq(GET('/api/parents/g1').body.parent_email, '');
  eq(GET('/api/outpasses').body.length, 0);
});

function seedPass(extra = {}) {
  const pass = {
    id: 'OP-T-001', guest_id: 'g1', guest_name: 'Asha Kulkarni', room_no: '204', parent_name: 'Mrs K', parent_email: 'mom@example.com',
    destination: 'Home', reason: 'Family function', leave_at: new Date().toISOString(), return_by: null, note: '', issued_by: '',
    status: 'issued', created_at: new Date().toISOString(), email: { status: 'sent' },
    approval: { status: 'pending', token: 'tok-abcdefghijklmnopqrstuvwxyz0123456789', expires_at: new Date(Date.now() + 3600e3).toISOString(), decided_at: null, comment: '' },
    ...extra,
  };
  fs.writeFileSync(path.join(tmp, 'outpasses.json'), JSON.stringify([pass]));
  return pass;
}
const storedPass = () => JSON.parse(fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8'))[0];
const TOK = 'tok-abcdefghijklmnopqrstuvwxyz0123456789';

test('the parent approval pages are a separate app that exposes nothing else', () => {
  ok(publicApp, 'a second app exists');
  const paths = [...publicApp.routes.GET, ...publicApp.routes.POST].map((r) => r.routePath).sort();
  eq(JSON.stringify(paths), JSON.stringify(['/outpass/respond', '/outpass/respond']), 'only the respond route');
  eq(PGET('/api/guests').status, 404, 'no roster on the public port');
  eq(PGET('/api/outpasses').status, 404, 'no pass list on the public port');
  eq(PGET('/api/health').status, 404);
});

test('the dashboard app does not serve the approval route', () => {
  eq(GET('/outpass/respond?id=OP-T-001&t=x').status, 404);
});

test('opening the email link shows the request and changes nothing', () => {
  seedPass();
  const before = fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8');
  const r = PGET(`/outpass/respond?id=OP-T-001&t=${TOK}&choice=approve`);
  eq(r.status, 200);
  ok(r.html.includes('Asha Kulkarni') && r.html.includes('Yes, approve this outpass'), 'shows details and a confirm button');
  ok(r.html.includes('method="post"'), 'confirms with a POST');
  eq(fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8'), before, 'a GET never decides');
  ok(!r.html.includes('mom@example.com'), "the parent's own address is not repeated");
});

test('the page is not cached, indexed, framed or allowed to run scripts', () => {
  seedPass();
  const h = PGET(`/outpass/respond?id=OP-T-001&t=${TOK}`).headers;
  eq(h['Cache-Control'], 'no-store');
  ok(/noindex/.test(h['X-Robots-Tag']));
  eq(h['X-Frame-Options'], 'DENY');
  ok(/default-src 'none'/.test(h['Content-Security-Policy']));
  eq(h['Referrer-Policy'], 'no-referrer');
});

test('pressing Approve records it; pressing again just shows the earlier answer', () => {
  seedPass();
  const r = PPOST('/outpass/respond', { id: 'OP-T-001', t: TOK, choice: 'approve' });
  eq(r.status, 200);
  ok(r.html.includes('Approved'), 'thanks the parent');
  eq(storedPass().approval.status, 'approved');
  const again = PPOST('/outpass/respond', { id: 'OP-T-001', t: TOK, choice: 'decline', comment: 'oops' });
  ok(again.html.includes('already answered'), 'says it was already answered');
  eq(storedPass().approval.status, 'approved', 'the second press changed nothing');
});

test('pressing Decline records it with the parent\'s reason, and closes the pass', () => {
  seedPass();
  const r = PPOST('/outpass/respond', { id: 'OP-T-001', t: TOK, choice: 'decline', comment: 'Exam tomorrow' });
  eq(r.status, 200);
  eq(storedPass().status, 'declined');
  eq(storedPass().approval.comment, 'Exam tomorrow');
});

test('a wrong token gets a generic 404 and nothing happens', () => {
  seedPass();
  eq(PGET('/outpass/respond?id=OP-T-001&t=wrong').status, 404);
  eq(PGET('/outpass/respond?id=OP-NOPE&t=' + TOK).status, 404);
  eq(PGET('/outpass/respond').status, 404);
  eq(PPOST('/outpass/respond', { id: 'OP-T-001', t: 'wrong', choice: 'approve' }).status, 404);
  eq(PPOST('/outpass/respond', {}).status, 404);
  eq(storedPass().approval.status, 'pending');
});

test('an expired link says so', () => {
  seedPass({ approval: { status: 'pending', token: TOK, expires_at: new Date(Date.now() - 1000).toISOString(), decided_at: null, comment: '' } });
  const r = PGET(`/outpass/respond?id=OP-T-001&t=${TOK}`);
  eq(r.status, 410);
  ok(r.html.includes('expired'));
});

test('anything a student typed is escaped on the parent page', () => {
  seedPass({ guest_name: '<script>alert(1)</script>', reason: '"><img src=x onerror=alert(1)>' });
  const r = PGET(`/outpass/respond?id=OP-T-001&t=${TOK}`);
  ok(!r.html.includes('<script>alert') && !r.html.includes('<img src=x'), 'no live markup');
});

test('GET /api/outpasses never includes approval tokens', () => {
  seedPass();
  const r = GET('/api/outpasses');
  eq(r.body.length, 1);
  ok(!JSON.stringify(r.body).includes(TOK), 'token absent from the dashboard list');
  eq(r.body[0].approval.status, 'pending');
});

test('health says whether parents can reach the buttons', () => {
  eq(typeof GET('/api/health').body.public_url_set, 'boolean');
});

test('an unrouted path 404s as JSON', () => {
  const r = GET('/api/nonsense');
  eq(r.status, 404);
  eq(typeof r.body.error, 'string');
});

// --------------------------------------------------------------------------
// Two cameras
// --------------------------------------------------------------------------

const liveViewModule = require('./live-view');
const FRAME = { image: 'aGVsbG8=', faces: [], width: 480, height: 270 };

test('by default Cam 1 is the entrance camera and Cam 2 the outside camera', () => {
  const r = GET('/api/cameras');
  eq(r.status, 200);
  eq(r.body.swapped, false);
  eq(r.body.cameras.find((c) => c.id === '1').role, 'in');
  eq(r.body.cameras.find((c) => c.id === '2').role, 'out');
});

test('swapping flips both roles and the choice survives a re-read', () => {
  const r = POST('/api/cameras', { swapped: true });
  eq(r.status, 200);
  eq(r.body.cameras.find((c) => c.id === '1').role, 'out');
  eq(r.body.cameras.find((c) => c.id === '2').role, 'in');
  eq(GET('/api/cameras').body.swapped, true, 'stored, not just echoed');

  eq(POST('/api/cameras', { swapped: false }).body.cameras[0].role, 'in', 'and back again');
});

test('swapping needs the service token and a real boolean', () => {
  eq(POST('/api/cameras', { swapped: true }, {}).status, 401);
  eq(POST('/api/cameras', { swapped: 'yes' }).status, 400);
  eq(GET('/api/cameras').body.swapped, false, 'a refused swap changes nothing');
});

test('each camera keeps its own live picture', () => {
  liveViewModule.resetAll();
  GET('/api/preview?cam=1');
  GET('/api/preview?cam=2');
  eq(POST('/api/preview', { ...FRAME, cam: '1', image: 'Zmlyc3Q=' }).status, 200);
  eq(POST('/api/preview', { ...FRAME, cam: '2', image: 'c2Vjb25k' }).status, 200);
  eq(GET('/api/preview?cam=1').body.frame.image, 'Zmlyc3Q=');
  eq(GET('/api/preview?cam=2').body.frame.image, 'c2Vjb25k');
});

test('a frame with no cam is Cam 1, so the single-camera setup still works', () => {
  liveViewModule.resetAll();
  eq(POST('/api/preview', FRAME).status, 200);
  eq(GET('/api/preview').body.frame.image, FRAME.image);
  eq(GET('/api/preview?cam=2').body.frame, null, 'Cam 2 saw nothing');
});

test('watching one camera does not wake the other', () => {
  liveViewModule.resetAll();
  GET('/api/preview?cam=1');
  eq(GET('/api/preview/state?cam=1').body.wanted, true);
  eq(GET('/api/preview/state?cam=2').body.wanted, false, 'Cam 2 stays asleep');
});

test('the live view switch covers both cameras', () => {
  liveViewModule.resetAll();
  POST('/api/preview/state', { enabled: false });
  eq(GET('/api/preview?cam=1').body.enabled, false);
  eq(GET('/api/preview?cam=2').body.enabled, false);
  POST('/api/preview/state', { enabled: true });
  eq(GET('/api/preview?cam=2').body.enabled, true);
});

test('a camera other than 1 or 2 is refused', () => {
  eq(GET('/api/preview?cam=3').status, 400);
  eq(GET('/api/preview/state?cam=x').status, 400);
  eq(POST('/api/preview', { ...FRAME, cam: '9' }).status, 400);
});

test('the camera that saw a movement is recorded', () => {
  const r = POST('/api/logs', { guest_id: 'g1', direction: 'out', camera: '2', event_id: 'cam-evt-1' });
  eq(r.status, 201);
  eq(r.body.log.camera, '2');
  eq(POST('/api/logs', { guest_id: 'g2', direction: 'in', camera: 'banana' }).body.log.camera, null,
    'junk is dropped, not stored');
});

test('an unknown face remembers which camera saw it', () => {
  POST('/api/unknown', { event_id: 'u-cam', best_score: 0.3, reason: 'below_threshold', direction: 'in', camera: '1' });
  eq(GET('/api/unknown').body[0].camera, '1');
});

console.log(`\n${passed}/${passed + failed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
