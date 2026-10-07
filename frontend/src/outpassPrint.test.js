import { approvalText, escapeHtml, outpassHtml, whenText } from './outpassPrint.js';
let pass = 0; let fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  pass ', n); } else { fail++; console.log('  FAIL ', n); } };
const p = {
  id: 'OP-1', guest_name: '<img src=x onerror=alert(1)>', room_no: '4', destination: 'Home',
  reason: '"><script>x</script>', leave_at: '2026-10-03T11:00:00Z', return_by: null, note: '',
  parent_email: 'a@b.com', email: { status: 'sent' },
};
const html = outpassHtml(p);
t('student text cannot inject markup', !html.includes('<img src=x') && !html.includes('"><script>x'));
t('shows the escaped text instead', html.includes('&lt;img src=x'));
t('says the parent was informed when email was sent', html.includes('Yes, by email'));
t('does not claim it when email failed', outpassHtml({ ...p, email: { status: 'failed' } }).includes('Not by email'));
t('escapeHtml handles quotes', escapeHtml('"\'') === '&quot;&#39;');
t('bad dates give empty text, not "Invalid Date"', whenText('nope') === '' && whenText(null) === '');
t('slip says APPROVED only when the parent approved', approvalText({ approval: { status: 'approved', decided_at: '2026-10-03T11:00:00Z' } }).startsWith('APPROVED'));
t('slip says so when still waiting', approvalText({ approval: { status: 'pending' } }).includes('Awaiting'));
t('slip says DECLINED, loudly', approvalText({ approval: { status: 'declined' } }).startsWith('DECLINED'));
t('old passes without approval never claim it', !approvalText({}).includes('APPROVED') && !approvalText({ approval: { status: 'not_requested' } }).includes('APPROVED'));
t('the slip HTML carries the approval line', outpassHtml({ ...p, approval: { status: 'declined' } }).includes('DECLINED by parent'));
console.log(`${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
