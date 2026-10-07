const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** Writes carry the shared token. It gates the LAN, not the user. */
function serviceHeaders() {
  return import.meta.env.VITE_SERVICE_TOKEN
    ? { 'X-Service-Token': import.meta.env.VITE_SERVICE_TOKEN }
    : {};
}

export const getSummary = () => call('/api/summary');
export const getHealth = () => call('/api/health');
export const getGuests = () => call('/api/guests');
export const getGuest = (id) => call(`/api/guests/${id}`);
export const getUnknownFaces = (limit = 20) => call(`/api/unknown?limit=${limit}`);

export function getLogs({ date, guestId, limit } = {}) {
  const q = new URLSearchParams();
  if (date) q.set('date', date);
  if (guestId) q.set('guest_id', guestId);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return call(`/api/logs${qs ? `?${qs}` : ''}`);
}

/** Manual override, for when the camera or the recognition service is down. */
export function logMovement({ guestId, direction, note, timestamp }) {
  return call('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({
      guest_id: guestId,
      direction,
      source: 'manual',
      note,
      // Omitted when the warden means "now": the server stamps it itself.
      ...(timestamp ? { timestamp } : {}),
    }),
  });
}

/**
 * Remove several guests at once. Deletes their face data and takes them off
 * the roster; their visit history is kept. Resolves to { removed, missing }.
 */
export function removeGuests(ids) {
  return call('/api/guests/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({ ids }),
  });
}

// --------------------------------------------------------------------------
// Outpasses
// --------------------------------------------------------------------------

export const getOutpasses = ({ status, guestId, limit } = {}) => {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (guestId) q.set('guest_id', guestId);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return call(`/api/outpasses${qs ? `?${qs}` : ''}`);
};

const post = (path, body) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify(body || {}),
  });

/** Issue a pass; the server emails the parent. Resolves to { outpass }. */
export const createOutpass = (fields) => post('/api/outpasses', fields);
export const resendOutpassEmail = (id) => post(`/api/outpasses/${encodeURIComponent(id)}/resend`);
export const closeOutpass = (id, status) =>
  post(`/api/outpasses/${encodeURIComponent(id)}/close`, { status });
export const getParent = (guestId) => call(`/api/parents/${encodeURIComponent(guestId)}`);

// --------------------------------------------------------------------------
// Live door view
// --------------------------------------------------------------------------

/**
 * One frame, plus the boxes to draw over it.
 *
 * Asking is what keeps the feed alive: the recognition service only encodes
 * pictures while this is being called. Stop calling and the mini PC stops
 * working for it, within a few seconds, without anyone pressing anything.
 */
export const getDoorView = (cam = '1') => call(`/api/preview?cam=${encodeURIComponent(cam)}`);

/**
 * Which physical camera does which job: Cam 1 watches the entrance (everyone
 * it recognises is coming IN) and Cam 2 the outside (going OUT), until swapped.
 * Returns { swapped, cameras: [{ id, role: 'in'|'out', label }] }.
 */
export const getCameras = () => call('/api/cameras');

export function setCamerasSwapped(swapped) {
  return call('/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({ swapped }),
  });
}

export function setDoorViewEnabled(enabled) {
  return call('/api/preview/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({ enabled }),
  });
}

// --------------------------------------------------------------------------
// Adding a guest
// --------------------------------------------------------------------------

/** Starts the enrollment and returns a job to poll. */
export function startEnrollment({ name, roomNo, phone, consent, photos }) {
  return call('/api/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({ name, room_no: roomNo, phone, consent, photos }),
  });
}

export const getEnrollment = (jobId) => call(`/api/enroll/${jobId}`);

/** "2026-09-18T19:04:11Z" -> "7:04 pm" */
export function clockTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Coarse but readable: "12 min ago", "3 hr ago", "yesterday". */
export function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Asha Kulkarni" -> "AK". The register never stores photos, so initials stand in. */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** 7:04 pm -> "07:04 PM", for the log tables. */
export function clockTimeUpper(iso) {
  if (!iso) return '—';
  return new Date(iso)
    .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    .toUpperCase();
}

/** "Today", "Yesterday", or "22 Oct". */
export function dayWord(iso) {
  const d = new Date(iso);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** 8700000 -> "2 hr 25 min". Under a minute reads "under a minute". */
export function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/**
 * For each "in", how long the guest was away: the gap back to the movement
 * just before it, but only when that movement was an "out". Anything else
 * (two ins in a row, no earlier out) has no honest duration, so it's null.
 *
 * Takes logs in any order; returns Map<logId, ms>.
 */
export function awayDurations(logs) {
  const asc = [...logs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const out = new Map();
  for (let i = 1; i < asc.length; i += 1) {
    if (asc[i].direction === 'in' && asc[i - 1].direction === 'out') {
      out.set(asc[i].id, new Date(asc[i].timestamp) - new Date(asc[i - 1].timestamp));
    }
  }
  return out;
}

/** Cosine similarity as the recogniser reports it: 0.62, not 62%. */
export const scoreText = (c) => (c == null ? null : Number(c).toFixed(2));
