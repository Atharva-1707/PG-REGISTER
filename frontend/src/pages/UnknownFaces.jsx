import { useCallback, useEffect, useMemo, useState } from 'react';
import { clockTime, getUnknownFaces } from '../api';
import { Empty, ErrorState, Loading } from '../components/StatusBits';

/**
 * Faces the matcher rejected — the page the README's tuning week runs on.
 *
 * These rows are deliberately kept out of the register. What they're good for
 * is reading the shape of the rejections: a pile of near-misses sitting just
 * under the threshold means real guests are being turned away, not that
 * strangers are streaming through the door.
 */

const DEFAULT_THRESHOLD = Number(import.meta.env.VITE_MATCH_THRESHOLD || 0.42);
const NEAR_MISS_BAND = 0.08; // "just under" — worth re-enrolling over

const REASON_LABEL = {
  below_threshold: 'Score too low',
  ambiguous: 'Two guests scored too close',
  empty_gallery: 'Nobody enrolled yet',
};

export default function UnknownFaces() {
  const [rows, setRows] = useState([]);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    return getUnknownFaces(200)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const stats = useMemo(() => {
    const scored = rows.filter((r) => typeof r.best_score === 'number');
    return {
      total: rows.length,
      nearMisses: scored.filter(
        (r) => r.best_score < threshold && r.best_score >= threshold - NEAR_MISS_BAND
      ).length,
      ambiguous: rows.filter((r) => r.reason === 'ambiguous').length,
    };
  }, [rows, threshold]);

  if (loading) return <Loading label="Reading rejected faces…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-space-lg px-gutter-mobile py-space-lg md:px-gutter">
      <header>
        <h1 className="font-headline-lg text-headline-lg">Unknown faces</h1>
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
          Faces the matcher saw but wouldn&rsquo;t put a name to. Run for a week with{' '}
          <code className="rounded bg-surface-container-high px-1 py-0.5 font-code-sm text-code-sm text-primary">LOG_UNKNOWNS=1</code> before
          changing any thresholds.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-container px-4 py-3 font-body-md text-body-md">
        <label htmlFor="threshold" className="text-on-surface-variant">
          Comparing against MATCH_THRESHOLD
        </label>
        <input
          id="threshold"
          type="number"
          step="0.01"
          min="0"
          max="1"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="w-20 rounded bg-surface-container-lowest px-2 py-1 font-code-tabular text-code-tabular text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="font-code-sm text-code-sm text-outline">
          set this to whatever the recognition service is actually running
        </span>
      </div>

      {stats.total > 0 && (
        <p className="font-body-md text-body-md text-on-surface-variant">
          {stats.total} rejected in the last run of the log. {stats.nearMisses} scored within{' '}
          {NEAR_MISS_BAND.toFixed(2)} of the threshold — if those are your own guests, re-enroll
          them with better photos before you lower it. {stats.ambiguous} were rejected for being
          too close to a second guest, which the margin is meant to catch.
        </p>
      )}

      {rows.length === 0 ? (
        <Empty>
          Nothing rejected yet. Either everyone walking past is enrolled and matching cleanly, or
          the recognition service is running with LOG_UNKNOWNS off.
        </Empty>
      ) : (
        <ul className="divide-y divide-surface-container-high/50 overflow-hidden rounded-xl bg-surface-container shadow-lg">
          {rows.map((row) => {
            const near =
              typeof row.best_score === 'number' &&
              row.best_score < threshold &&
              row.best_score >= threshold - NEAR_MISS_BAND;
            return (
              <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-16 shrink-0 font-code-tabular text-code-tabular text-on-surface">
                  {typeof row.best_score === 'number' ? row.best_score.toFixed(3) : '—'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-body-md text-body-md">
                    {REASON_LABEL[row.reason] || row.reason}
                    {near && <span className="ml-2 font-code-sm text-code-sm text-tertiary">near miss</span>}
                  </p>
                  <p className="mt-0.5 font-code-sm text-code-sm text-outline">
                    {row.direction ? `Walking ${row.direction}` : 'Direction unclear'}
                  </p>
                </div>
                <time className="shrink-0 font-code-tabular text-code-tabular text-on-surface-variant" dateTime={row.timestamp}>
                  {clockTime(row.timestamp)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
