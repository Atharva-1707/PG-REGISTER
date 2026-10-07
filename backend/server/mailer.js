/**
 * The email a parent gets when their child is given an outpass.
 *
 * Three outcomes, and the caller always learns which one happened:
 *   sent   - handed to the SMTP server
 *   saved  - email is not set up yet, so the message was written to
 *            data/outbox/ for you to read (nothing is lost, nothing is sent)
 *   failed - email is set up but sending did not work; the reason is kept
 *
 * send() never throws. An outpass must still exist when the mail server is
 * down, because the student is physically leaving either way.
 */

const fs = require('fs');
const path = require('path');

function config(env = process.env) {
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: (env.SMTP_HOST || '').trim(),
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS, which nodemailer does itself.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: (env.MAIL_FROM || env.SMTP_USER || '').trim(),
    pgName: (env.PG_NAME || 'Sai Residency PG').trim(),
    contact: (env.PG_CONTACT || '').trim(),
    timeZone: (env.PG_TIMEZONE || 'Asia/Kolkata').trim(),
    // Where the Approve / Decline buttons point. Must be reachable from the
    // parent's phone; the default only works on this computer.
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PUBLIC_PORT || 4001}`).trim().replace(/\/+$/, ''),
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.host && cfg.from);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** "Sat, 3 Oct 2026, 4:30 pm" in the PG's own time zone, not the server's. */
function formatWhen(iso, timeZone = 'Asia/Kolkata') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-IN', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return d.toISOString();
  }
}

/** The two links, or null when there is nothing left to answer. */
function approvalLinks(pass, cfg) {
  const a = pass.approval;
  if (!a || a.status !== 'pending' || !a.token) return null;
  const base = `${cfg.publicUrl}/outpass/respond?id=${encodeURIComponent(pass.id)}&t=${encodeURIComponent(a.token)}`;
  return { approve: `${base}&choice=approve`, decline: `${base}&choice=decline` };
}

/** Build subject, plain text and HTML for one outpass. Pure: easy to test. */
function buildMessage(pass, cfg = config()) {
  const when = (iso) => formatWhen(iso, cfg.timeZone);
  const greeting = pass.parent_name ? `Dear ${pass.parent_name},` : 'Dear Parent / Guardian,';
  const links = approvalLinks(pass, cfg);
  const a = pass.approval || {};
  const answered = a.status === 'approved' || a.status === 'declined';

  const rows = [
    ['Student', `${pass.guest_name} (Room ${pass.room_no})`],
    ['Going to', pass.destination],
    ['Reason', pass.reason],
    ['Leaving', when(pass.leave_at)],
  ];
  if (pass.return_by) rows.push(['Expected back', when(pass.return_by)]);
  if (pass.note) rows.push(['Note', pass.note]);
  rows.push(['Outpass no.', pass.id]);

  const intro = links
    ? `${pass.guest_name} has asked to leave ${cfg.pgName} for ${pass.destination}. Please approve or decline below.`
    : `${pass.guest_name} has been given an outpass by ${cfg.pgName} to leave for ${pass.destination}.`;

  const help = cfg.contact
    ? `If you were not expecting this, please contact us straight away on ${cfg.contact}.`
    : 'If you were not expecting this, please contact the PG office straight away.';

  const answeredLine = answered
    ? `Your answer: ${a.status === 'approved' ? 'Approved' : 'Declined'}${a.decided_at ? ` on ${when(a.decided_at)}` : ''}.`
    : '';
  const expires = links && a.expires_at ? `These buttons work until ${when(a.expires_at)}.` : '';

  const text = [
    greeting,
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(links
      ? [
        `APPROVE: ${links.approve}`,
        `DECLINE: ${links.decline}`,
        expires,
        '',
      ]
      : []),
    ...(answeredLine ? [answeredLine, ''] : []),
    help,
    '',
    `Regards,\n${cfg.pgName}`,
  ].join('\n');

  const button = (href, label, bg) => `<td style="padding:0 6px 0 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 26px;border-radius:8px">${label}</a></td>`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dde3ea">
  <div style="background:#0b6b80;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:bold">${escapeHtml(cfg.pgName)} &middot; ${links ? 'Outpass request' : 'Outpass issued'}</div>
  <div style="padding:20px">
    <p style="margin:0 0 12px">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px">${escapeHtml(intro)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows.map(([k, v]) => `<tr><td style="padding:7px 0;color:#5b667a;width:38%;vertical-align:top">${escapeHtml(k)}</td><td style="padding:7px 0;font-weight:600">${escapeHtml(v)}</td></tr>`).join('\n      ')}
    </table>
    ${links ? `<table role="presentation" style="margin:22px 0 6px"><tr>${button(links.approve, '&#10003; Approve', '#1a7f4b')}${button(links.decline, '&#10005; Decline', '#b3261e')}</tr></table>
    <p style="margin:6px 0 0;font-size:12px;color:#5b667a">${escapeHtml(expires)}</p>` : ''}
    ${answeredLine ? `<p style="margin:18px 0 0;font-weight:bold">${escapeHtml(answeredLine)}</p>` : ''}
    <p style="margin:18px 0 0;font-size:13px;color:#5b667a">${escapeHtml(help)}</p>
  </div>
</div></body></html>`;

  const subject = `${links ? 'Approval needed: outpass for' : 'Outpass for'} ${pass.guest_name} - leaving ${when(pass.leave_at)}`
    .replace(/[\r\n]+/g, ' ');

  return { subject, text, html };
}

let cachedTransport = null;
let cachedKey = '';

function getTransport(cfg) {
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (cachedTransport && key === cachedKey) return cachedTransport;
  // Loaded here, not at the top, so the API still starts if `npm install`
  // has not been run since nodemailer was added.
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  cachedKey = key;
  return cachedTransport;
}

/** Short, secret-free reason for the dashboard. */
function explain(err) {
  const msg = String((err && err.message) || err || 'unknown error');
  if (err && err.code === 'MODULE_NOT_FOUND') {
    return 'The email package is not installed. Run "npm install" in the backend folder, then restart.';
  }
  if (err && err.code === 'EAUTH') {
    return 'The mail server refused the username or password. For Gmail, use an App Password, not your normal password.';
  }
  if (err && (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'EDNS')) {
    return 'Could not reach the mail server. Check SMTP_HOST, SMTP_PORT and the internet connection.';
  }
  return msg.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/**
 * Send (or save) the outpass email. Resolves to { status, detail }.
 * `options.transport` lets tests pass a fake with a sendMail() method.
 */
async function send(pass, to, options = {}) {
  const cfg = options.cfg || config();
  const message = buildMessage(pass, cfg);

  if (!options.transport && !isConfigured(cfg)) {
    try {
      const dir = options.outboxDir || path.join(require('./db').DATA_DIR, 'outbox');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${pass.id}-${Date.now()}.txt`);
      fs.writeFileSync(
        file,
        `To: ${to}\nSubject: ${message.subject}\n\n${message.text}\n`,
        'utf8'
      );
      return {
        status: 'saved',
        detail: 'Email is not set up yet, so the message was saved in the data/outbox folder instead of being sent.',
      };
    } catch (err) {
      return { status: 'failed', detail: explain(err) };
    }
  }

  try {
    const transport = options.transport || getTransport(cfg);
    await transport.sendMail({
      from: cfg.from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { status: 'sent', detail: `Sent to ${to}.` };
  } catch (err) {
    console.error(`[mail] could not send ${pass.id}: ${err.message}`);
    return { status: 'failed', detail: explain(err) };
  }
}

module.exports = { config, isConfigured, buildMessage, approvalLinks, formatWhen, escapeHtml, send };
