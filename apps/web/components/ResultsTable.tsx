'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import type { ExperimentResultWire } from '../lib/types';
import { Badge, buttonClass } from './ui';

/**
 * Failure explorer over the run's per-request rows (already fetched server-side, max 5,000).
 * Filtering is client-side over THAT data only — no extra fetch, no invented rows. Latency is
 * rendered as ms with the microsecond source kept honest: `latencyMicros` is a decimal STRING on
 * the wire (bigint has no JSON literal), parsed exactly once here. Rows stagger in on mount and on
 * every filter change (reduced-motion safe) purely as a reading aid — the animation never adds,
 * removes, reorders, or restates a value; the numbers are the runner's own.
 */
const selectField =
  'rounded-lg border border-edge bg-panel px-2.5 py-1 text-sm text-ink outline-none transition-colors focus:border-brand';

function outcomeBadge(outcome: ExperimentResultWire['outcome']) {
  if (outcome === 'SUCCEEDED') return <Badge tone="ok">{outcome}</Badge>;
  if (outcome === 'SOLD_OUT' || outcome === 'CONFLICT' || outcome === 'DUPLICATE') return <Badge tone="warn">{outcome}</Badge>;
  return <Badge tone="danger">{outcome}</Badge>;
}

export function ResultsTable({ results }: { results: ExperimentResultWire[] }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [failureClass, setFailureClass] = useState<string>('all');
  const bodyRef = useRef<HTMLTableSectionElement>(null);

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

  // Re-run a gentle row entrance whenever the visible set changes (filter, sort, or new data).
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || bodyRef.current === null) return;
    const rows = Array.from(bodyRef.current.children);
    const ctx = gsap.context(() => {
      // Cap the stagger cost on very large tables: animate the first screenful only, reveal the rest at once.
      gsap.from(rows.slice(0, 60), { autoAlpha: 0, y: 6, duration: 0.28, stagger: 0.015, ease: 'power2.out' });
    }, bodyRef);
    return () => ctx.revert();
  }, [visible]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl2 border border-edge bg-panel p-3 text-sm shadow-1">
        <label className="flex cursor-pointer items-center gap-2 font-medium text-ink">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
            className="h-4 w-4 rounded accent-[var(--brand)]"
          />
          Failures only
        </label>
        <label className="flex items-center gap-2 text-muted">
          Failure class
          <select value={failureClass} onChange={(e) => setFailureClass(e.target.value)} className={selectField}>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {(failuresOnly || failureClass !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setFailuresOnly(false);
              setFailureClass('all');
            }}
            className={buttonClass('ghost', 'sm')}
          >
            Clear filters
          </button>
        )}
        <p role="status" aria-live="polite" className="ml-auto text-xs text-muted">
          <span className="font-semibold text-ink tabular-nums">{visible.length.toLocaleString('en-US')}</span> of{' '}
          {results.length.toLocaleString('en-US')} rows shown
        </p>
      </div>

      <div className="tf-scroll max-h-[28rem] overflow-auto rounded-xl2 border border-edge bg-panel shadow-1">
        <table className="w-full border-collapse text-xs">
          <caption className="caption-top px-3 pt-2.5 text-left text-xs text-muted">
            Every request the runner issued, with the outcome and failure class the runner recorded for it.
          </caption>
          <thead className="sticky top-0 z-10 bg-elevated text-left text-muted shadow-[0_1px_0_var(--edge)]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">#</th>
              <th scope="col" className="px-3 py-2 font-medium">Actor</th>
              <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
              <th scope="col" className="px-3 py-2 font-medium">HTTP</th>
              <th scope="col" className="px-3 py-2 font-medium">Latency (ms)</th>
              <th scope="col" className="px-3 py-2 font-medium">Failure class</th>
              <th scope="col" className="px-3 py-2 font-medium">Correlation id</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-edge transition-colors hover:bg-elevated/60">
                <td className="px-3 py-1.5 tabular-nums text-muted">{r.requestIndex}</td>
                <td className="px-3 py-1.5">{r.actorLabel}</td>
                <td className="px-3 py-1.5">{outcomeBadge(r.outcome)}</td>
                <td className="px-3 py-1.5 tabular-nums">{r.httpStatus ?? '—'}</td>
                <td className="px-3 py-1.5 tabular-nums">{(Number(r.latencyMicros) / 1000).toFixed(2)}</td>
                <td className="px-3 py-1.5 text-muted">{r.failureClass}</td>
                <td className="px-3 py-1.5 font-mono text-muted">{r.correlationId.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
