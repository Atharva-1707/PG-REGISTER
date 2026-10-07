/**
 * Outpass + email tests. No mail server and no network: a fake transport
 * stands in for SMTP, and the "email not set up" path writes to a temp folder.
 *
 *   node backend/server/outpass.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-outpass-'));
process.env.DATA_DIR = tmp;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[k];

const outpass = require('./outpass');
const mailer = require('./mailer');

const NOW = new Date('2026-10-03T10:00:00.000Z');
const db = require('./db');
const RAW_GUESTS = [
  { id: 'g1', name: 'Asha Kulkarni', room_no: '204' },
  { id: 'g2', name: 'Rohit Deshmukh', room_no: '101' },
  { id: 'g3', name: 'Moved Out', room_no: '9', active: false },
];
let GUESTS = [];

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
function eq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function reset() {
  fs.writeFileSync(path.join(tmp, 'guests.json'), JSON.stringify(RAW_GUESTS));
  GUESTS = db.readGuests(); // same shape the server validates against
  for (const f of ['outpasses.json', 'parents.json']) fs.rmSync(path.join(tmp, f), { force: true });
  fs.rmSync(path.join(tmp, 'outbox'), { recursive: true, force: true });
}

const good = {
  guest_id: 'g1',
  parent_name: 'Mrs. Kulkarni',
  parent_email: 'Mom@Example.com',
  reason: 'Family function',
  leave_at: '2026-10-03T11:00:00.000Z',
  return_by: '2026-10-05T14:00:00.000Z',
};

const fakeTransport = () => {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return {}; } };
};
const brokenTransport = (code, message) => ({
  sendMail: async () => { const e = new Error(message); e.code = code; throw e; },
});

test('a good request validates and cleans its fields', () => {
  const r = outpass.validate(good, { guests: GUESTS, now: NOW });
  ok(!r.error, r.error);
  eq(r.value.parent_email, 'mom@example.com', 'email lower-cased');
  eq(r.value.destination, 'Home', 'destination defaults to Home');
});

test('refuses missing or bad input with a plain message', () => {
  const v = (patch) => outpass.validate({ ...good, ...patch }, { guests: GUESTS, now: NOW });
  eq(v({ guest_id: 'nope' }).code, 'bad_guest');
  eq(v({ guest_id: 'g3' }).code, 'bad_guest', 'moved-out guests cannot get a pass');
  eq(v({ parent_email: '' }).code, 'no_email');
  eq(v({ parent_email: 'not-an-email' }).code, 'bad_email');
  eq(v({ parent_email: 'a@b.com, c@d.com' }).code, 'bad_email', 'one recipient only');
  eq(v({ parent_email: 'a@b.com\nBcc: x@y.com' }).code, 'bad_email', 'no header injection');
  eq(v({ reason: ' ' }).code, 'no_reason');
  eq(v({ leave_at: 'tomorrow-ish' }).code, 'bad_leave');
  eq(v({ leave_at: '2026-09-01T00:00:00Z' }).code, 'leave_past');
  eq(v({ leave_at: '2027-03-01T00:00:00Z' }).code, 'leave_far');
  eq(v({ return_by: '2026-10-03T10:30:00Z' }).code, 'return_before_leave');
});

test('control characters in text fields are flattened to one line', () => {
  const r = outpass.validate({ ...good, reason: 'Home\r\nBcc: x@y.com', note: 'a\u0000b' }, { guests: GUESTS, now: NOW });
  ok(!/[\r\n\u0000]/.test(r.value.reason + r.value.note), 'no control characters survive');
});

test('creating a pass stores it, remembers the parent, and saves the email when mail is not set up', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  ok(!r.error, r.error);
  eq(r.outpass.id, 'OP-20261003-001');
  eq(r.outpass.status, 'issued');
  eq(r.outpass.email.status, 'saved');
  const box = fs.readdirSync(path.join(tmp, 'outbox'));
  eq(box.length, 1);
  const text = fs.readFileSync(path.join(tmp, 'outbox', box[0]), 'utf8');
  ok(text.includes('To: mom@example.com') && text.includes('Asha Kulkarni'), 'file has recipient and student');
  eq(outpass.getParent('g1').parent_email, 'mom@example.com', 'parent contact remembered');
});

test('an email really is handed to the transport, addressed to the parent', async () => {
  reset();
  const t = fakeTransport();
  const r = await outpass.create(good, { now: NOW, mail: { transport: t, cfg: mailer.config({ PG_NAME: 'Test PG' }) } });
  eq(r.outpass.email.status, 'sent');
  eq(t.sent.length, 1);
  eq(t.sent[0].to, 'mom@example.com');
  ok(t.sent[0].subject.includes('Asha Kulkarni'), 'subject names the student');
  ok(t.sent[0].text.includes('Family function') && t.sent[0].text.includes('OP-20261003-001'), 'body has reason and pass number');
});

test('a mail failure still leaves the pass issued, with a readable reason', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW, mail: { transport: brokenTransport('EAUTH', 'Invalid login: 535 secret-stuff') } });
  ok(!r.error, 'the pass is still created');
  eq(r.outpass.status, 'issued');
  eq(r.outpass.email.status, 'failed');
  ok(/App Password/.test(r.outpass.email.detail), 'explains the Gmail password gotcha');
  ok(!/secret-stuff/.test(r.outpass.email.detail), 'does not echo server text for auth failures');
  eq(outpass.list().length, 1);
});

test('resend retries the email on an existing pass', async () => {
  reset();
  await outpass.create(good, { now: NOW, mail: { transport: brokenTransport('ETIMEDOUT', 'timeout') } });
  const t = fakeTransport();
  const r = await outpass.resend('OP-20261003-001', { mail: { transport: t } });
  eq(r.outpass.email.status, 'sent');
  eq(t.sent.length, 1);
  eq((await outpass.resend('OP-nope')).status, 404);
});

test('one open pass per student; a second is refused until the first is closed', async () => {
  reset();
  await outpass.create(good, { now: NOW });
  const dup = await outpass.create(good, { now: NOW });
  eq(dup.code, 'already_open');
  eq(dup.status, 409);
  eq(outpass.close('OP-20261003-001', 'returned', NOW).outpass.status, 'returned');
  const again = await outpass.create(good, { now: NOW });
  ok(!again.error, 'allowed once the first is returned');
  eq(again.outpass.id, 'OP-20261003-002', 'ids keep counting');
});

test('close handles returned, cancelled, repeats and nonsense', async () => {
  reset();
  await outpass.create(good, { now: NOW });
  eq(outpass.close('OP-20261003-001', 'cancelled', NOW).outpass.status, 'cancelled');
  eq(outpass.close('OP-20261003-001', 'returned', NOW).code, 'already_closed');
  eq(outpass.close('OP-20261003-001', 'deleted', NOW).code, 'bad_status');
  eq(outpass.close('OP-nope', 'returned', NOW).status, 404);
});

test('overdue is flagged for open passes past their return time', async () => {
  reset();
  await outpass.create(good, { now: NOW });
  eq(outpass.list({ now: new Date('2026-10-04T00:00:00Z') })[0].overdue, false);
  eq(outpass.list({ now: new Date('2026-10-06T00:00:00Z') })[0].overdue, true);
  outpass.close('OP-20261003-001', 'returned', NOW);
  eq(outpass.list({ now: new Date('2026-10-06T00:00:00Z') })[0].overdue, false, 'returned passes are never overdue');
});

test('saved parent contact: validated, and not overwritten when "remember" is off', async () => {
  reset();
  eq(outpass.saveParent('g1', { parent_email: 'bad' }).code, 'bad_email');
  eq(outpass.saveParent('zz', { parent_email: 'a@b.com' }).status, 404);
  outpass.saveParent('g1', { parent_name: 'Dad', parent_email: 'dad@example.com' });
  await outpass.create({ ...good, remember_parent: false }, { now: NOW });
  eq(outpass.getParent('g1').parent_email, 'dad@example.com');
  eq(outpass.getParent('g2').parent_email, '', 'unknown guest gives empty strings, not an error');
});

test('the HTML email escapes anything a student could have typed', () => {
  const html = mailer.buildMessage({
    ...good, id: 'OP-1', guest_name: '<img src=x onerror=alert(1)>', room_no: '1',
    destination: 'Home', reason: '"><script>x</script>', note: '', parent_name: '',
  }).html;
  ok(!/<script>|<img src/.test(html), 'markup is escaped');
  ok(html.includes('&lt;script&gt;'), 'shown as text instead');
});

test('times in the email use the PG time zone, not the server zone', () => {
  const t = mailer.formatWhen('2026-10-03T11:00:00.000Z', 'Asia/Kolkata');
  ok(/4:30/.test(t) && /pm/i.test(t), `expected 4:30 pm IST, got ${t}`);
});


const rawPass = (id) => JSON.parse(fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8')).find((p) => p.id === id);

test('a new pass waits for the parent, and the token never reaches the dashboard', async () => {
  const r = await outpass.create(good, { now: NOW });
  eq(r.outpass.approval.status, 'pending');
  ok(!('token' in r.outpass.approval), 'create() does not leak the token');
  ok(!('token' in outpass.list()[0].approval), 'list() does not leak the token');
  ok(rawPass(r.outpass.id).approval.token.length >= 30, 'but one is stored, long enough to be unguessable');
});

test('the email carries Approve and Decline links that hold the pass token', async () => {
  reset();
  const t = fakeTransport();
  const r = await outpass.create(good, { now: NOW, mail: { transport: t, cfg: mailer.config({ PUBLIC_URL: 'https://pg.example.com/' }) } });
  const token = rawPass(r.outpass.id).approval.token;
  const m = t.sent[0];
  ok(m.text.includes(`https://pg.example.com/outpass/respond?id=OP-20261003-001&t=${token}&choice=approve`), 'approve link in text');
  ok(m.text.includes('choice=decline'), 'decline link in text');
  ok(m.html.includes('Approve') && m.html.includes('Decline') && m.html.includes(`t=${token}`), 'buttons in html');
});

test('opening the link (a GET) changes nothing: scanners open links before parents do', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  const before = fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8');
  for (let i = 0; i < 3; i += 1) eq(outpass.lookup(r.outpass.id, token, NOW).state, 'pending');
  eq(fs.readFileSync(path.join(tmp, 'outpasses.json'), 'utf8'), before, 'file untouched');
});

test('approving: recorded once, the pass stays open and is marked approved', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  const done = outpass.respond(r.outpass.id, token, 'approve', '', NOW);
  eq(done.state, 'done');
  eq(done.outpass.approval.status, 'approved');
  eq(done.outpass.status, 'issued', 'still an open pass until the student is back');
  eq(outpass.respond(r.outpass.id, token, 'decline', 'changed my mind', NOW).state, 'decided', 'first answer is final');
  eq(outpass.list()[0].approval.status, 'approved');
});

test('declining: pass closes as declined, comment kept, and the student can be issued a new one', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  const done = outpass.respond(r.outpass.id, token, 'decline', 'Exam tomorrow\r\nBcc: x', NOW);
  eq(done.outpass.status, 'declined');
  eq(done.outpass.approval.comment, 'Exam tomorrow Bcc: x', 'comment flattened to one line');
  eq(outpass.close(r.outpass.id, 'returned', NOW).code, 'already_closed');
  const again = await outpass.create(good, { now: NOW });
  ok(!again.error, 'a declined pass does not block the next request');
});

test('wrong id, wrong token, short token and empty token are all just "invalid"', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  eq(outpass.lookup(r.outpass.id, token + 'x', NOW).state, 'invalid');
  eq(outpass.lookup(r.outpass.id, token.slice(1), NOW).state, 'invalid');
  eq(outpass.lookup(r.outpass.id, '', NOW).state, 'invalid');
  eq(outpass.lookup('OP-nope', token, NOW).state, 'invalid');
  eq(outpass.respond(r.outpass.id, 'guess', 'approve', '', NOW).state, 'invalid');
  eq(outpass.list()[0].approval.status, 'pending', 'nothing changed');
});

test('an unknown choice is refused and changes nothing', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  eq(outpass.respond(r.outpass.id, token, 'maybe', '', NOW).state, 'invalid_choice');
  eq(outpass.list()[0].approval.status, 'pending');
});

test('links expire, and resending gives them a fresh window', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  const late = new Date(NOW.getTime() + 73 * 3600 * 1000);
  eq(outpass.lookup(r.outpass.id, token, late).state, 'expired');
  eq(outpass.respond(r.outpass.id, token, 'approve', '', late).state, 'expired');
  await outpass.resend(r.outpass.id, { now: late, mail: { transport: fakeTransport() } });
  eq(outpass.lookup(r.outpass.id, token, late).state, 'pending', 'same link works again after a resend');
});

test('a cancelled or returned pass can no longer be answered', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  outpass.close(r.outpass.id, 'cancelled', NOW);
  eq(outpass.respond(r.outpass.id, token, 'approve', '', NOW).state, 'closed');
  eq((await outpass.resend(r.outpass.id)).code, 'already_closed', 'and there is nothing to resend');
});

test('after the parent answers, a resent email says so and has no buttons', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  const token = rawPass(r.outpass.id).approval.token;
  outpass.respond(r.outpass.id, token, 'approve', '', NOW);
  const t = fakeTransport();
  await outpass.resend(r.outpass.id, { now: NOW, mail: { transport: t } });
  ok(!t.sent[0].text.includes('choice=approve'), 'no buttons once answered');
  ok(/Your answer: Approved/.test(t.sent[0].text), 'states the answer');
});

test('passes from before approval existed get buttons when resent', async () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'outpasses.json'), JSON.stringify([{
    id: 'OP-OLD-001', guest_id: 'g1', guest_name: 'Asha Kulkarni', room_no: '204', parent_name: '', parent_email: 'mom@example.com',
    destination: 'Home', reason: 'x', leave_at: NOW.toISOString(), return_by: null, note: '', issued_by: '',
    status: 'issued', created_at: NOW.toISOString(), email: { status: 'sent' },
  }]));
  eq(outpass.list()[0].approval.status, 'not_requested');
  const t = fakeTransport();
  await outpass.resend('OP-OLD-001', { now: NOW, mail: { transport: t } });
  ok(t.sent[0].text.includes('choice=approve'), 'upgraded with buttons');
  eq(outpass.list()[0].approval.status, 'pending');
});

test('a student cannot answer for their parent by typing into the dashboard API shape', async () => {
  reset();
  const r = await outpass.create(good, { now: NOW });
  // An attacker who saw the list can read everything except the token.
  const seen = JSON.stringify(outpass.list());
  ok(!seen.includes(rawPass(r.outpass.id).approval.token), 'token appears nowhere in the list output');
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      reset();
      await fn();
      passed += 1;
      console.log(`  pass  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${name}: ${err.message}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
