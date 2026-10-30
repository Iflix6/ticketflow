'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import type { LabRunDto } from '../lib/types';
import { buttonClass, StatusBadge } from './ui';

/**
 * Runs table + compare affordance. Selection is deliberately capped at two: the compare page plots
 * grouped bars per run, and more series than two would need a legend nobody can read at a glance.
 * All figures in the table come from the run document the server already aggregated — the client
 * never recounts results. Rows stagger in once on mount (skipped under reduced-motion) as a reading
 * aid; no row is ever added, removed, or reordered by the animation.
 */
export function CompareSelector({ runs }: { runs: LabRunDto[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || bodyRef.current === null) return;
    const ctx = gsap.context(() => {
      gsap.from(Array.from(bodyRef.current!.children), { autoAlpha: 0, y: 8, duration: 0.35, stagger: 0.04, ease: 'power2.out' });
    }, bodyRef);
    return () => ctx.revert();
  }, [runs]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [...prev.slice(1), id] : [...prev, id],
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl2 border border-edge">
        <div className="tf-scroll overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Newest first. Outcomes come straight from each run&apos;s stored aggregation.
            </caption>
            <thead>
              <tr className="bg-elevated text-left text-muted">
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Select up to two runs to compare</span>
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">Run</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Strategy</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Succeeded / attempted</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Invariant violations</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Started</th>
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-edge transition-colors hover:bg-elevated/60">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select run ${run.id.slice(0, 8)} (${run.strategy}) for comparison`}
                      checked={selected.includes(run.id)}
                      onChange={() => toggle(run.id)}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/lab/runs/${run.id}`} className="font-mono text-xs text-brand underline underline-offset-2">
                      {run.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">{run.strategy}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge value={run.status} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {run.outcomes ? `${run.outcomes.succeeded} / ${run.outcomes.attempted}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {run.outcomes ? (
                      run.outcomes.invariantViolations > 0 ? (
                        <span className="font-semibold text-danger">{run.outcomes.invariantViolations}</span>
                      ) : (
                        <span className="text-ok">0</span>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{new Date(run.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={selected.length !== 2}
          onClick={() => router.push(`/lab/runs/compare?a=${selected[0]}&b=${selected[1]}`)}
          className={buttonClass('primary', 'sm')}
        >
          Compare selected ({selected.length}/2)
        </button>
        <p className="text-xs text-muted">Select exactly two runs — checking a third replaces the oldest pick.</p>
      </div>
    </div>
  );
}
