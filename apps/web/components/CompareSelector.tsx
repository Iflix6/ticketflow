'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import type { LabRunDto } from '../lib/types';

/**
 * Runs table + compare affordance. Selection is deliberately capped at two: the compare page plots
 * grouped bars per run, and more series than two would need a legend nobody can read at a glance.
 * All figures in the table come from the run document the server already aggregated — the client
 * never recounts results.
 */
export function CompareSelector({ runs }: { runs: LabRunDto[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [...prev.slice(1), id] : [...prev, id],
    );
  }

  return (
    <div className="space-y-3">
      <table className="w-full border-collapse bg-white text-sm">
        <caption className="caption-top pb-2 text-left text-xs text-slate-500">
          Newest first. Outcomes come straight from each run&apos;s stored aggregation.
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-left">
            <th scope="col" className="py-2 pr-2">
              <span className="sr-only">Select up to two runs to compare</span>
            </th>
            <th scope="col" className="py-2 pr-4">Run</th>
            <th scope="col" className="py-2 pr-4">Strategy</th>
            <th scope="col" className="py-2 pr-4">Status</th>
            <th scope="col" className="py-2 pr-4">Succeeded / attempted</th>
            <th scope="col" className="py-2 pr-4">Invariant violations</th>
            <th scope="col" className="py-2">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-slate-100">
              <td className="py-2 pr-2">
                <input
                  type="checkbox"
                  aria-label={`Select run ${run.id.slice(0, 8)} (${run.strategy}) for comparison`}
                  checked={selected.includes(run.id)}
                  onChange={() => toggle(run.id)}
                />
              </td>
              <td className="py-2 pr-4">
                <Link href={`/lab/runs/${run.id}`} className="font-mono text-xs underline">
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td className="py-2 pr-4">{run.strategy}</td>
              <td className="py-2 pr-4">
                <span
                  className={
                    run.status === 'COMPLETED'
                      ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-900'
                      : run.status === 'FAILED' || run.status === 'ABORTED'
                        ? 'rounded bg-red-100 px-2 py-0.5 text-xs text-red-900'
                        : 'rounded bg-slate-100 px-2 py-0.5 text-xs'
                  }
                >
                  {run.status}
                </span>
              </td>
              <td className="py-2 pr-4">
                {run.outcomes ? `${run.outcomes.succeeded} / ${run.outcomes.attempted}` : '—'}
              </td>
              <td className="py-2 pr-4">
                {run.outcomes ? (
                  run.outcomes.invariantViolations > 0 ? (
                    <span className="font-semibold text-red-700">{run.outcomes.invariantViolations}</span>
                  ) : (
                    '0'
                  )
                ) : (
                  '—'
                )}
              </td>
              <td className="py-2">{new Date(run.startedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={selected.length !== 2}
          onClick={() => router.push(`/lab/runs/compare?a=${selected[0]}&b=${selected[1]}`)}
          className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 disabled:opacity-40"
        >
          Compare selected ({selected.length}/2)
        </button>
        <p className="text-xs text-slate-500">Select exactly two runs — checking a third replaces the oldest pick.</p>
      </div>
    </div>
  );
}
