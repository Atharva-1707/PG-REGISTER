// Pure helpers, no browser or Vite globals, so they can be tested with plain node.

/**
 * Turn the form's time choice into an ISO timestamp, or an explanation.
 *
 * "Now" returns null so the server stamps it. A specific time is read as
 * today's clock time; if that is still in the future it can only mean last
 * night (e.g. "11:30 pm" typed at 1am) — and only if that falls after the 4am
 * rollover, because older movements no longer count toward today's state.
 */
function fmt(d) {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
}

export function resolveTimestamp(mode, hhmm, dayStartIso, now = new Date()) {
  if (mode === 'now') return { iso: null };
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return { error: 'Pick a time.' };

  const [h, m] = hhmm.split(':').map(Number);
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);

  const dayStart = dayStartIso ? new Date(dayStartIso) : null;
  if (candidate > now) {
    const yesterday = new Date(candidate);
    yesterday.setDate(yesterday.getDate() - 1);
    if (dayStart && yesterday >= dayStart) return { iso: yesterday.toISOString() };
    return { error: 'That time hasn’t happened yet today.' };
  }
  if (dayStart && candidate < dayStart) {
    return {
      error: `The register started today at ${fmt(dayStart)}. Pick a time after that.`,
    };
  }
  return { iso: candidate.toISOString() };
}
