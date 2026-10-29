import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { ErrorPanel } from '../../../../components/ErrorPanel';
import { GroupedBars } from '../../../../components/GroupedBars';
import type { LabRunDto } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

/**
 * Side-by-side comparison of exactly two runs. Every number is read off the two stored run
 * documents; nothing is averaged, extrapolated, or simulated here. The pack's warning applies:
 * differing seeds make runs NOT comparable — this page says so instead of silently plotting.
 */
export default async function CompareRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { a, b } = await searchParams;
  if (a === undefined || b === undefined) {
    return (
      <p role="alert" className="text-sm">
        Compare needs two run ids (`?a=…&amp;b=…`). Pick them with the checkboxes on the{' '}
        <Link href="/lab" className="underline">
          runs list
        </Link>
        .
      </p>
    );
  }

  let runA: LabRunDto;
  let runB: LabRunDto;
  try {
    const [ra, rb] = await Promise.all([
      serverApi<{ data: LabRunDto }>(`/api/v1/lab/runs/${a}`),
      serverApi<{ data: LabRunDto }>(`/api/v1/lab/runs/${b}`),
    ]);
    runA = ra.data;
    runB = rb.data;
  } catch (error) {
    return <ErrorPanel error={error} />;
  }

  const comparable =
    runA.configuration.seed === runB.configuration.seed &&
    runA.configuration.capacity === runB.configuration.capacity &&
    runA.configuration.concurrentUsers === runB.configuration.concurrentUsers &&
    runA.configuration.quantityPerUser === runB.configuration.quantityPerUser;

  const outcomeKeys = [
    'succeeded',
    'soldOut',
    'conflict',
    'duplicate',
    'validationError',
    'serverError',
    'timeout',
  ] as const;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Compare runs</h1>

      {!comparable && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          These runs differ in seed or load shape (capacity / buyers / seats-per-buyer), so their bars
          sit side by side for reference only — the difference is NOT attributable to the strategy alone.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {[runA, runB].map((run) => (
          <section key={run.id} aria-label={`Run ${run.id.slice(0, 8)} configuration`} className="rounded border border-slate-200 bg-white p-3 text-sm">
            <h2 className="font-semibold">
              <Link href={`/lab/runs/${run.id}`} className="underline">
                {run.strategy}
              </Link>{' '}
              <span className="font-mono text-xs text-slate-500">{run.id.slice(0, 8)}</span>
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              capacity {run.configuration.capacity} · {run.configuration.concurrentUsers} buyers ×{' '}
              {run.configuration.quantityPerUser} seat(s) · seed {run.configuration.seed} ·{' '}
              {run.configuration.isolation}
              {run.strategy === 'unsafe_lab' ? ` · window delay ${run.configuration.artificialDelayMs}ms` : ''}
            </p>
          </section>
        ))}
      </div>

      <GroupedBars
        title="Outcome mix (counts from each run document)"
        categories={outcomeKeys.map((k) => k)}
        series={[
          { name: `${runA.strategy} ${runA.id.slice(0, 6)}`, color: '#1d4ed8', values: outcomeKeys.map((k) => runA.outcomes?.[k] ?? 0) },
          { name: `${runB.strategy} ${runB.id.slice(0, 6)}`, color: '#b45309', values: outcomeKeys.map((k) => runB.outcomes?.[k] ?? 0) },
        ]}
      />

      <GroupedBars
        title="Latency percentiles (ms)"
        categories={['p50', 'p95', 'p99']}
        series={[
          { name: runA.strategy, color: '#1d4ed8', values: [runA.outcomes?.p50Ms, runA.outcomes?.p95Ms, runA.outcomes?.p99Ms].map((v) => v ?? 0) },
          { name: runB.strategy, color: '#b45309', values: [runB.outcomes?.p50Ms, runB.outcomes?.p95Ms, runB.outcomes?.p99Ms].map((v) => v ?? 0) },
        ]}
      />

      <table className="w-full max-w-xl border-collapse bg-white text-sm">
        <caption className="caption-top pb-2 text-left text-xs text-slate-500">
          Headline numbers, verbatim from the stored outcomes.
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-left">
            <th scope="col">Metric</th>
            <th scope="col">{runA.strategy} {runA.id.slice(0, 6)}</th>
            <th scope="col">{runB.strategy} {runB.id.slice(0, 6)}</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['Attempted', (r: LabRunDto) => r.outcomes?.attempted?.toLocaleString('en-US') ?? '—'],
              ['Succeeded', (r: LabRunDto) => r.outcomes?.succeeded?.toLocaleString('en-US') ?? '—'],
              ['Invariant violations', (r: LabRunDto) => r.outcomes?.invariantViolations.toLocaleString('en-US') ?? '—'],
              ['Throughput (req/s)', (r: LabRunDto) => r.outcomes?.throughputPerSecond?.toFixed(1) ?? '—'],
              ['Duration (ms)', (r: LabRunDto) => r.outcomes?.durationMs?.toLocaleString('en-US') ?? '—'],
            ] as const
          ).map(([label, get]) => (
            <tr key={label} className="border-b border-slate-100">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {label}
              </th>
              <td className="py-1.5 pr-4">{get(runA)}</td>
              <td className="py-1.5">{get(runB)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
