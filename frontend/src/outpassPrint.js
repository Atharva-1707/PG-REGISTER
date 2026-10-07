/**
 * A printable outpass: the slip the student can show at the gate.
 *
 * Built as a plain HTML string and opened in its own window, so printing never
 * drags the dashboard along with it. Everything a student could have typed goes
 * through escapeHtml first.
 */

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function whenText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Plain words for what the parent said. A slip must never imply approval it does not have. */
export function approvalText(pass) {
  const a = pass.approval || {};
  if (a.status === 'approved') return `APPROVED by parent${a.decided_at ? ` on ${whenText(a.decided_at)}` : ''}`;
  if (a.status === 'declined') return 'DECLINED by parent: do not allow to leave';
  if (a.status === 'pending') return 'Awaiting parent\'s answer';
  return 'Parent informed only';
}

export function outpassHtml(pass, pgName = 'Sai Residency PG') {
  const rows = [
    ['Student', `${pass.guest_name} (Room ${pass.room_no})`],
    ['Going to', pass.destination],
    ['Reason', pass.reason],
    ['Leaving', whenText(pass.leave_at)],
    ...(pass.return_by ? [['Expected back', whenText(pass.return_by)]] : []),
    ...(pass.note ? [['Note', pass.note]] : []),
    ['Parent informed', pass.email && pass.email.status === 'sent' ? `Yes, by email (${pass.parent_email})` : 'Not by email'],
    ['Parent approval', approvalText(pass)],
    ...(pass.issued_by ? [['Issued by', pass.issued_by]] : []),
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Outpass ${escapeHtml(pass.id)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:32px}
  .slip{max-width:560px;margin:0 auto;border:2px solid #111;border-radius:8px;padding:24px}
  h1{margin:0 0 4px;font-size:22px} .sub{color:#555;margin:0 0 16px;font-size:13px}
  .id{font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:15px}
  td{padding:8px 0;border-bottom:1px solid #ddd;vertical-align:top} td:first-child{color:#555;width:36%}
  .sig{margin-top:44px;display:flex;justify-content:space-between;font-size:13px;color:#555}
  .sig div{border-top:1px solid #111;padding-top:6px;width:44%}
  @media print{body{margin:0}}
</style></head><body><div class="slip">
<h1>${escapeHtml(pgName)}</h1><p class="sub">Outpass</p>
<div class="id">${escapeHtml(pass.id)}</div>
<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`).join('')}</table>
<div class="sig"><div>Warden</div><div>Student</div></div>
</div><script>window.onload=function(){window.print()}</script></body></html>`;
}

export function printOutpass(pass, pgName) {
  const w = window.open('', '_blank', 'width=720,height=800');
  if (!w) return false; // pop-up blocked
  w.document.open();
  w.document.write(outpassHtml(pass, pgName));
  w.document.close();
  return true;
}
