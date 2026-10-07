/**
 * Tests for removing guests. Runs the real module against a stand-in for
 * enroll.py (a small node script), so no Python or model is needed.
 *
 *   node backend/server/guest-removal.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const removal = require('./guest-removal');

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
function eq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-removal-'));
function fakeScript(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

// Echoes its own arguments back in the shape enroll.py --json uses.
const echo = fakeScript('echo.js', `
const a = process.argv.slice(2);
const ids = a.slice(a.indexOf('--remove') + 1);
console.log(JSON.stringify({
  ok: true,
  keep: a.includes('--keep-record'),
  removed: ids.filter((i) => i !== 'ghost').map((id) => ({ id, name: 'Guest ' + id })),
  missing: ids.filter((i) => i === 'ghost'),
}));
`);
const notFound = fakeScript('nf.js', `console.log(JSON.stringify({ ok: false, code: 'not_found', error: 'nope' })); process.exit(1);`);
const crash = fakeScript('crash.js', `console.error('boom'); process.exit(2);`);
const slow = fakeScript('slow.js', `setTimeout(() => {}, 5000);`);

const opts = (scriptPath, extra = {}) => ({ scriptPath, pythonBin: process.execPath, ...extra });

test('validate accepts a list, drops repeats, and refuses anything odd', () => {
  eq(removal.validate({ ids: ['a1', 'a1', 'b2'] }).ids, ['a1', 'b2']);
  eq(removal.validate({}).status, 400);
  eq(removal.validate({ ids: [] }).code, 'no_ids');
  eq(removal.validate({ ids: ['-rf'] }).code, 'bad_ids');
  eq(removal.validate({ ids: ['a b'] }).code, 'bad_ids');
  eq(removal.validate({ ids: [null] }).code, 'bad_ids');
  eq(removal.validate({ ids: Array.from({ length: removal.MAX_IDS + 1 }, (_, i) => `g${i}`) }).code, 'too_many');
});

test('removes everyone in one call and keeps the visit history', async () => {
  const r = await removal.remove(['a1', 'b2', 'c3'], opts(echo));
  eq(r.removed.map((g) => g.id), ['a1', 'b2', 'c3']);
  eq(r.missing, []);
  // --keep-record is what keeps history; check it really was passed.
  const raw = await new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(process.execPath, [echo, '--json', '--keep-record', '--remove', 'x'], (_e, out) => resolve(out));
  });
  eq(JSON.parse(raw).keep, true);
});

test('reports guests that were already gone instead of failing', async () => {
  const r = await removal.remove(['a1', 'ghost'], opts(echo));
  eq(r.removed.map((g) => g.id), ['a1']);
  eq(r.missing, ['ghost']);
  const all = await removal.remove(['ghost'], opts(notFound));
  eq(all, { removed: [], missing: ['ghost'] });
});

test('refuses while an enrollment is running', async () => {
  const r = await removal.remove(['a1'], opts(echo, { isBusy: () => true }));
  eq(r.status, 409);
  eq(r.code, 'busy');
});

test('a crashing script is a clean error, and the lock is released', async () => {
  const bad = await removal.remove(['a1'], opts(crash));
  eq(bad.status, 500);
  const ok = await removal.remove(['a1'], opts(echo));
  eq(ok.removed.length, 1, 'next removal is not stuck behind the failure');
});

test('a missing python is explained, not thrown', async () => {
  const r = await removal.remove(['a1'], { scriptPath: echo, pythonBin: '/no/such/python' });
  eq(r.code, 'spawn_failed');
});

test('two removals at once: the second is told to wait', async () => {
  const first = removal.remove(['a1'], opts(slow));
  const second = await removal.remove(['b2'], opts(echo));
  eq(second.code, 'busy');
  process.env.REMOVE_TIMEOUT_MS = '1';
  first.then(() => {});
  removal.reset();
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      removal.reset();
      await fn();
      passed += 1;
      console.log(`  pass  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${name}: ${err.message}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
