/**
 * The small web pages a parent sees after tapping Approve or Decline.
 *
 * Plain HTML with no scripts: it has to work in any phone's mail app browser.
 * Opening the page changes nothing; only the button on it does. That is what
 * makes it safe from mail scanners and link previews, which open every link.
 */

const { escapeHtml, formatWhen } = require('./mailer');

function shell(title, body, pgName) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2433}
  .wrap{max-width:480px;margin:0 auto;padding:16px}
  .card{background:#fff;border:1px solid #dde3ea;border-radius:12px;overflow:hidden}
  .top{background:#0b6b80;color:#fff;padding:14px 18px;font-weight:bold;font-size:17px}
  .in{padding:18px}
  h1{font-size:20px;margin:0 0 10px}
  p{line-height:1.45;margin:0 0 12px}
  table{width:100%;border-collapse:collapse;font-size:15px;margin:6px 0 16px}
  td{padding:7px 0;vertical-align:top} td:first-child{color:#5b667a;width:38%}
  .btn{display:block;width:100%;border:0;border-radius:10px;padding:16px;font-size:18px;font-weight:bold;color:#fff;cursor:pointer}
  .yes{background:#1a7f4b} .no{background:#b3261e}
  textarea{width:100%;box-sizing:border-box;border:1px solid #c5ccd6;border-radius:8px;padding:10px;font:inherit;min-height:70px;margin:0 0 12px}
  .alt{text-align:center;margin-top:14px;font-size:14px} .alt a{color:#0b6b80}
  .ok{color:#1a7f4b} .bad{color:#b3261e} .muted{color:#5b667a;font-size:13px}
</style></head><body><div class="wrap"><div class="card">
<div class="top">${escapeHtml(pgName)}</div><div class="in">${body}</div></div></div></body></html>`;
}

function details(pass, tz) {
  const when = (iso) => formatWhen(iso, tz);
  const rows = [
    ['Student', `${pass.guest_name} (Room ${pass.room_no})`],
    ['Going to', pass.destination],
    ['Reason', pass.reason],
    ['Leaving', when(pass.leave_at)],
  ];
  if (pass.return_by) rows.push(['Expected back', when(pass.return_by)]);
  if (pass.note) rows.push(['Note', pass.note]);
  return `<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`).join('')}</table>`;
}

/** The page the email buttons open: shows the request and one button to confirm. */
function confirmPage({ pass, id, token, choice, cfg }) {
  const link = (c) => `/outpass/respond?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}&choice=${c}`;
  const hidden = (c) => `<input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="t" value="${escapeHtml(token)}"><input type="hidden" name="choice" value="${c}">`;

  const form = (c) => `<form method="post" action="/outpass/respond">${hidden(c)}
    ${c === 'decline' ? '<textarea name="comment" maxlength="300" placeholder="Reason (optional) — the warden will see this"></textarea>' : ''}
    <button class="btn ${c === 'approve' ? 'yes' : 'no'}" type="submit">${c === 'approve' ? 'Yes, approve this outpass' : 'Decline this outpass'}</button></form>`;

  let actions;
  if (choice === 'approve' || choice === 'decline') {
    const other = choice === 'approve' ? 'decline' : 'approve';
    actions = `${form(choice)}<p class="alt">Changed your mind? <a href="${link(other)}">${other === 'approve' ? 'Approve instead' : 'Decline instead'}</a></p>`;
  } else {
    actions = `${form('approve')}<div style="height:12px"></div>${form('decline')}`;
  }

  return shell(
    'Outpass request',
    `<h1>Outpass request</h1>
     <p>${escapeHtml(pass.guest_name)} has asked to leave. Please check the details and confirm.</p>
     ${details(pass, cfg.timeZone)}${actions}
     <p class="muted" style="margin-top:16px">Your answer is final once you press the button. To change it, please call the PG${cfg.contact ? ` on ${escapeHtml(cfg.contact)}` : ''}.</p>`,
    cfg.pgName
  );
}

function resultPage({ pass, decision, cfg, justNow }) {
  const approved = decision === 'approved';
  return shell(
    approved ? 'Approved' : 'Declined',
    `<h1 class="${approved ? 'ok' : 'bad'}">${approved ? '✓ Approved' : '✕ Declined'}</h1>
     <p>${justNow ? 'Thank you. ' : 'You have already answered. '}${approved
    ? `${escapeHtml(pass.guest_name)} is allowed to leave, and the warden has been told.`
    : `${escapeHtml(pass.guest_name)} will not be allowed to leave, and the warden has been told.`}</p>
     ${details(pass, cfg.timeZone)}
     <p class="muted">You can close this page.</p>`,
    cfg.pgName
  );
}

function messagePage({ title, text, cfg }) {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${cfg.contact ? `<p class="muted">PG office: ${escapeHtml(cfg.contact)}</p>` : ''}`,
    cfg.pgName
  );
}

module.exports = { confirmPage, resultPage, messagePage };
