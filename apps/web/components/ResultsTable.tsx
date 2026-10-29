'use client';

import { useMemo, useState } from 'react';
import type { ExperimentResultWire } from '../lib/types';

/**
 * Failure explorer over the run's per-request rows (already fetched server-side, max 5,000).
 * Filtering is client-side over THAT data only — no extra fetch, no invented rows. Latency is
 * rendered as ms with the microsecond source kept honest: `latencyMicros` is a decimal STRING on
 * the wire (bigint has no JSON literal), parsed exactly once here.
 */
export function ResultsTable({ results }: { results: ExperimentResultWire[] }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [failureClass, setFailureClass] = useState<string>('all');

  const classes = useMemo(
    () => ['all', ...Array.from(new Set(results.map((r) => r.failureClass))).sort()],
    [results],
  );

  const visible = useMemo(
    () =>
      results.filter(
        (r) => (!failuresOnly || r.outcome !== 'SUCCEEDED') && (failureClass === 'all' || r.failureClass === failureClass),
      ),
    [results, failuresOnly, failureClass],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
          />
          Failures only
        </label>
        <label className="flex items-center gap-2">
          Failure class
          <select
            value={failureClass}
            onChange={(e) => setFailureClass(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          >
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p role="status" aria-live="polite" className="text-xs text-slate-500">
          {visible.length} of {results.length} rows shown
        </p>
      </div>

      <div className="max-h-[28rem] overflow-auto rounded border border-slate-200">
        <table className="w-full border-collapse bg-white text-xs">
          <caption className="caption-top px-2 pt-2 text-left text-xs text-slate-500">
            Every request the runner issued, with the outcome and failure class the runner recorded for it.
          </caption>
          <thead className="sticky top-0 bg-slate-100 text-left">
            <tr>
              <th scope="col" className="px-2 py-1.5">#</th>
              <th scope="col" className="px-2 py-1.5">Actor</th>
              <th scope="col" className="px-2 py-1.5">Outcome</th>
              <th scope="col" className="px-2 py-1.5">HTTP</th>
              <th scope="col" className="px-2 py-1.5">Latency (ms)</th>
              <th scope="col" className="px-2 py-1.5">Failure class</th>
              <th scope="col" className="px-2 py-1.5">Correlation id</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-2 py-1">{r.requestIndex}</td>
                <td className="px-2 py-1">{r.actorLabel}</td>
                <td className="px-2 py-1">
                  <span
                    className={
                      r.outcome === 'SUCCEEDED'
                        ? 'text-green-800'
                        : r.outcome === 'SOLD_OUT' || r.outcome === 'CONFLICT'
                          ? 'text-amber-800'
                          : 'font-semibold text-red-700'
                    }
                  >
                    {r.outcome}
                  </span>
                </td>
                <td className="px-2 py-1">{r.httpStatus ?? '—'}</td>
                <td className="px-2 py-1">{(Number(r.latencyMicros) / 1000).toFixed(2)}</td>
                <td className="px-2 py-1">{r.failureClass}</td>
                <td className="px-2 py-1 font-mono">{r.correlationId.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
