import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  closeOutpass,
  createOutpass,
  getGuests,
  getHealth,
  getOutpasses,
  getParent,
  resendOutpassEmail,
} from '../api';
import { printOutpass, whenText } from '../outpassPrint';
import { Avatar, Empty, ErrorState, Icon, Loading } from '../components/StatusBits';

const inputClass =
  'w-full rounded bg-surface-container-lowest px-space-md py-2.5 font-body-md text-body-md text-on-surface '
  + 'placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 focus:ring-primary transition-all';
const labelClass = 'mb-1 block font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant';

const REASONS = ['Going home', 'Family function', 'Festival / holiday', 'Medical', 'Exam / college work'];

/** "2026-10-03T16:30" in the browser's own zone, for <input type="datetime-local">. */
function toLocalInput(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function EmailBadge({ email }) {
  if (!email) return null;
  const map = {
    sent: ['mark_email_read', 'text-secondary', 'Parent emailed'],
    saved: ['drafts', 'text-tertiary', 'Email not set up (saved)'],
    failed: ['error', 'text-tertiary', 'Email failed'],
    pending: ['schedule', 'text-on-surface-variant', 'Sending…'],
  };
  const [icon, tone, label] = map[email.status] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1 font-code-sm text-code-sm ${tone}`} title={email.detail || ''}>
      <Icon name={icon} className="text-base" /> {label}
    </span>
  );
}

function PassStatus({ pass }) {
  const a = (pass.approval && pass.approval.status) || 'not_requested';
  if (pass.status === 'returned') return <Pill tone="in">Returned</Pill>;
  if (pass.status === 'cancelled') return <Pill tone="muted">Cancelled</Pill>;
  if (pass.status === 'declined') return <Pill tone="bad">Declined by parent</Pill>;
  if (pass.overdue) return <Pill tone="bad">Overdue</Pill>;
  if (a === 'pending') return <Pill tone="out">Awaiting parent</Pill>;
  if (a === 'approved') return <Pill tone="in">Approved</Pill>;
  return <Pill tone="out">Out</Pill>;
}

/** A declined pass stays in the Open list for a day so the warden cannot miss it. */
const isOpenish = (p) =>
  p.status === 'issued'
  || (p.status === 'declined' && Date.now() - new Date(p.declined_at || p.created_at).getTime() < 24 * 3600 * 1000);

function Pill({ tone, children }) {
  const tones = {
    in: 'bg-secondary/15 text-secondary',
    out: 'bg-tertiary/15 text-tertiary',
    bad: 'bg-error-container text-on-error-container',
    muted: 'bg-surface-container-highest text-on-surface-variant',
  };
  return (
    <span className={`rounded-full px-3 py-1 font-label-caps text-label-caps uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ResultBanner({ result, onDismiss }) {
  const { outpass } = result;
  const status = outpass.email.status;
  const good = status === 'sent';
  return (
    <div
      role="status"
      className={`rounded-xl p-space-md ${good ? 'bg-secondary/10 text-secondary' : 'bg-tertiary/10 text-tertiary'}`}
    >
      <p className="font-body-md text-body-md font-semibold">
        {good
          ? `Request ${outpass.id} sent to ${outpass.parent_name || 'the parent'} (${outpass.parent_email}). The student should wait until it shows Approved here.`
          : `Request ${outpass.id} saved, but the parent was NOT emailed, so nobody can approve it yet.`}
      </p>
      {!good && <p className="mt-1 font-body-md text-body-md">{outpass.email.detail}</p>}
      <div className="mt-3">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-3 py-1.5 font-body-md text-body-md text-on-surface-variant hover:bg-surface-container-high"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function Outpass() {
  const [params, setParams] = useSearchParams();
  const [guests, setGuests] = useState([]);
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [publicUrlSet, setPublicUrlSet] = useState(true);

  const [filter, setFilter] = useState('open');
  const [busyId, setBusyId] = useState(null);
  const [rowMessage, setRowMessage] = useState(null);

  const blank = useCallback(() => ({
    guestId: params.get('guest') || '',
    parentName: '',
    parentEmail: '',
    reasonPick: REASONS[0],
    reasonOther: '',
    destination: 'Home',
    leaveAt: toLocalInput(new Date()),
    returnBy: '',
    note: '',
    issuedBy: localStorage.getItem('gatelog.issuedBy') || '',
    remember: true,
  }), [params]);

  const [form, setForm] = useState(blank);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [result, setResult] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const load = useCallback(async () => {
    try {
      const [g, p, h] = await Promise.all([
        getGuests(),
        getOutpasses({ limit: 200 }),
        getHealth().catch(() => ({ public_url_set: true })),
      ]);
      setPublicUrlSet(h.public_url_set !== false);
      setGuests(g.filter((x) => x.active));
      setPasses(p);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Quick refresh: the warden is waiting for the parent's answer.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  // Picking a student fills in the parent's email from last time.
  useEffect(() => {
    if (!form.guestId) return undefined;
    let alive = true;
    getParent(form.guestId)
      .then((p) => {
        if (!alive) return;
        setForm((f) => (f.guestId !== form.guestId ? f : {
          ...f,
          parentName: f.parentName || p.parent_name || '',
          parentEmail: f.parentEmail || p.parent_email || '',
        }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [form.guestId]);

  const openCount = passes.filter(isOpenish).length;
  const visible = useMemo(
    () => passes.filter((p) => filter === 'all' || isOpenish(p)),
    [passes, filter]
  );
  const alreadyOut = useMemo(
    () => new Set(passes.filter((p) => p.status === 'issued').map((p) => p.guest_id)),
    [passes]
  );

  const submit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setResult(null);
    if (!form.guestId) return setFormError('Choose a student.');
    const reason = form.reasonPick === 'Other' ? form.reasonOther.trim() : form.reasonPick;
    setSubmitting(true);
    try {
      const out = await createOutpass({
        guest_id: form.guestId,
        parent_name: form.parentName,
        parent_email: form.parentEmail,
        reason,
        destination: form.destination,
        leave_at: form.leaveAt ? new Date(form.leaveAt).toISOString() : undefined,
        return_by: form.returnBy ? new Date(form.returnBy).toISOString() : undefined,
        note: form.note,
        issued_by: form.issuedBy,
        remember_parent: form.remember,
      });
      localStorage.setItem('gatelog.issuedBy', form.issuedBy);
      setResult(out);
      setParams({}, { replace: true });
      setForm({ ...blank(), guestId: '', issuedBy: form.issuedBy });
      setFilter('open');
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (pass, fn, okText) => {
    setBusyId(pass.id);
    setRowMessage(null);
    try {
      const r = await fn();
      setRowMessage({ id: pass.id, ok: true, text: okText(r) });
      await load();
    } catch (err) {
      setRowMessage({ id: pass.id, ok: false, text: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const print = (pass) => {
    if (!printOutpass(pass)) setRowMessage({ id: pass.id, ok: false, text: 'Your browser blocked the print window. Allow pop-ups for this page and try again.' });
  };

  if (loading) return <div className="p-gutter"><Loading label="Loading outpasses…" /></div>;
  if (loadError && guests.length === 0) {
    return <div className="p-gutter"><ErrorState message={loadError} onRetry={load} /></div>;
  }

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      <header>
        <h1 className="font-headline-lg text-headline-lg">Outpass</h1>
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
          Ask a parent before a student goes home. They get an email with Approve and Decline buttons, and their answer shows up here.
        </p>
      </header>

      {!publicUrlSet && (
        <p role="note" className="rounded-xl bg-tertiary/10 px-4 py-3 font-body-md text-body-md text-tertiary">
          Approve / Decline buttons in emails currently point to this computer, so a parent on their own phone cannot open them.
          To fix that, set <code>PUBLIC_URL</code> in <code>backend\.env</code> (see the README, &ldquo;Letting parents reach the approval page&rdquo;).
          You can still test by opening the email on this computer.
        </p>
      )}

      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} />}

      <form onSubmit={submit} className="grid gap-space-md rounded-xl bg-surface-container p-space-lg shadow-lg md:grid-cols-2">
        <div className="md:col-span-2">
          <label className={labelClass} htmlFor="op-guest">Student</label>
          <select
            id="op-guest"
            value={form.guestId}
            // Switching student clears the parent fields so one student's
            // email can never ride along to another; the saved one refills below.
            onChange={(e) => setForm((f) => ({ ...f, guestId: e.target.value, parentName: '', parentEmail: '' }))}
            className={inputClass}
            required
          >
            <option value="">Choose a student…</option>
            {guests.map((g) => (
              <option key={g.id} value={g.id} disabled={alreadyOut.has(g.id)}>
                {g.room_no} · {g.name}{alreadyOut.has(g.id) ? ' (already out on a pass)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="op-pname">Parent / guardian name</label>
          <input id="op-pname" value={form.parentName} onChange={set('parentName')} className={inputClass} placeholder="Optional" maxLength={80} />
        </div>
        <div>
          <label className={labelClass} htmlFor="op-pmail">Parent&rsquo;s email</label>
          <input id="op-pmail" type="email" value={form.parentEmail} onChange={set('parentEmail')} className={inputClass} placeholder="parent@example.com" required />
        </div>

        <div>
          <label className={labelClass} htmlFor="op-reason">Reason</label>
          <select id="op-reason" value={form.reasonPick} onChange={set('reasonPick')} className={inputClass}>
            {REASONS.map((r) => <option key={r}>{r}</option>)}
            <option>Other</option>
          </select>
          {form.reasonPick === 'Other' && (
            <input value={form.reasonOther} onChange={set('reasonOther')} className={`${inputClass} mt-2`} placeholder="Type the reason" maxLength={200} required />
          )}
        </div>
        <div>
          <label className={labelClass} htmlFor="op-dest">Going to</label>
          <input id="op-dest" value={form.destination} onChange={set('destination')} className={inputClass} maxLength={100} />
        </div>

        <div>
          <label className={labelClass} htmlFor="op-leave">Leaving</label>
          <input id="op-leave" type="datetime-local" value={form.leaveAt} onChange={set('leaveAt')} className={inputClass} required />
        </div>
        <div>
          <label className={labelClass} htmlFor="op-back">Expected back <span className="normal-case opacity-60">(optional)</span></label>
          <input id="op-back" type="datetime-local" value={form.returnBy} onChange={set('returnBy')} className={inputClass} />
        </div>

        <div>
          <label className={labelClass} htmlFor="op-note">Note <span className="normal-case opacity-60">(optional, shown to the parent)</span></label>
          <input id="op-note" value={form.note} onChange={set('note')} className={inputClass} maxLength={300} />
        </div>
        <div>
          <label className={labelClass} htmlFor="op-by">Issued by</label>
          <input id="op-by" value={form.issuedBy} onChange={set('issuedBy')} className={inputClass} placeholder="Your name" maxLength={60} />
        </div>

        <label className="flex items-center gap-2 font-body-md text-body-md text-on-surface-variant md:col-span-2">
          <input type="checkbox" checked={form.remember} onChange={set('remember')} className="h-4 w-4 accent-primary" />
          Remember this email for next time
        </label>

        {formError && (
          <p role="alert" className="rounded-lg bg-tertiary/10 px-3 py-2 font-body-md text-body-md text-tertiary md:col-span-2">{formError}</p>
        )}

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 font-body-md text-body-md font-semibold text-on-primary transition-colors hover:bg-primary-fixed disabled:opacity-60"
          >
            <Icon name="send" className="text-xl" />
            {submitting ? 'Sending…' : 'Send request to parent'}
          </button>
        </div>
      </form>

      <section className="flex flex-col gap-space-md">
        <div className="flex flex-wrap items-center gap-2">
          {[['open', `Open (${openCount})`], ['all', `All (${passes.length})`]].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-full px-3 py-1.5 font-body-md text-body-md transition-colors ${
                filter === key
                  ? 'bg-primary-container font-semibold text-on-primary'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <Empty>{filter === 'open' ? 'No open outpass requests right now.' : 'No outpasses yet.'}</Empty>
        ) : (
          <ul className="divide-y divide-surface-container-high/50 overflow-hidden rounded-xl bg-surface-container shadow-lg">
            {visible.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 px-space-md py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={p.guest_name} tone={p.status === 'issued' ? 'out' : 'neutral'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-body-md text-body-md font-semibold">
                      {p.guest_name} <span className="font-code-tabular text-code-tabular text-on-surface-variant">· Room {p.room_no}</span>
                    </p>
                    <p className="truncate font-code-sm text-code-sm text-outline">
                      {p.destination} · {p.reason} · left {whenText(p.leave_at)}
                      {p.return_by && ` · back by ${whenText(p.return_by)}`}
                    </p>
                  </div>
                  <PassStatus pass={p} />
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12">
                  <span className="font-code-sm text-code-sm text-on-surface-variant">{p.id}</span>
                  <EmailBadge email={p.email} />
                  <span className="ml-auto flex flex-wrap gap-1">
                    {(p.approval.status === 'approved' || p.approval.status === 'not_requested') && (
                      <button type="button" onClick={() => print(p)} className="rounded px-2 py-1 font-body-md text-body-md text-primary hover:bg-surface-container-high">Print</button>
                    )}
                    {p.status === 'issued' && (
                      <button
                        type="button"
                        disabled={busyId === p.id}
                        onClick={() => act(p, () => resendOutpassEmail(p.id), (r) => (r.outpass.email.status === 'sent' ? 'Email sent again.' : r.outpass.email.detail))}
                        className="rounded px-2 py-1 font-body-md text-body-md text-primary hover:bg-surface-container-high disabled:opacity-50"
                      >
                        {p.approval.status === 'pending' ? 'Resend request' : 'Resend email'}
                      </button>
                    )}
                    {p.status === 'issued' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === p.id}
                          onClick={() => act(p, () => closeOutpass(p.id, 'returned'), () => 'Marked as returned.')}
                          className="rounded px-2 py-1 font-body-md text-body-md text-secondary hover:bg-surface-container-high disabled:opacity-50"
                        >
                          Mark returned
                        </button>
                        <button
                          type="button"
                          disabled={busyId === p.id}
                          onClick={() => act(p, () => closeOutpass(p.id, 'cancelled'), () => 'Outpass cancelled.')}
                          className="rounded px-2 py-1 font-body-md text-body-md text-tertiary hover:bg-surface-container-high disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </span>
                </div>

                {rowMessage && rowMessage.id === p.id && (
                  <p role="status" className={`pl-12 font-body-md text-body-md ${rowMessage.ok ? 'text-secondary' : 'text-tertiary'}`}>
                    {rowMessage.text}
                  </p>
                )}
                {p.approval.status === 'declined' && (
                  <p role="alert" className="pl-12 font-body-md text-body-md text-tertiary">
                    The parent declined{p.approval.comment ? `: \u201c${p.approval.comment}\u201d` : '.'} Do not let {p.guest_name} leave.
                  </p>
                )}
                {p.approval.status === 'approved' && p.approval.decided_at && (
                  <p className="pl-12 font-body-md text-body-md text-secondary">
                    Parent approved on {whenText(p.approval.decided_at)}.
                  </p>
                )}
                {p.email && p.email.status !== 'sent' && p.email.detail && (
                  <p className="pl-12 font-body-md text-body-md text-on-surface-variant">{p.email.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
