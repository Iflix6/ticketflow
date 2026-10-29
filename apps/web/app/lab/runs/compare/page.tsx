import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { ErrorPanel } from '../../../../components/ErrorPanel';
import { GroupedBars } from '../../../../components/GroupedBars';
import { PageHeader, SectionLabel, Callout, StatusBadge } from '../../../../components/ui';
import type { LabRunDto } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

const SERIES_A = '#6366f1';
const SERIES_B = '#f59e0b';

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
      <div role="alert">
        <Callout tone="info">
          Compare needs two run ids (`?a=…&amp;b=…`). Pick them with the checkboxes on the{' '}
          <Link href="/lab" className="font-medium underline underline-offset-2">
            runs list
          </Link>
          .
        </Callout>
      </div>
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
    <div className="space-y-8">
      <PageHeader title="Compare runs" actions={<Link href="/lab" className="text-sm text-brand underline underline-offset-2">← All runs</Link>} />

      {!comparable && (
        <div role="alert">
          <Callout tone="warn">
            These runs differ in seed or load shape (capacity / buyers / seats-per-buyer), so their bars
            sit side by side for reference only — the difference is NOT attributable to the strategy alone.
          </Callout>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {[runA, runB].map((run, i) => (
          <div key={run.id} className="rounded-xl border border-edge bg-panel p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold">
                <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: i === 0 ? SERIES_A : SERIES_B }} />
                <Link href={`/lab/runs/${run.id}`} className="underline underline-offset-2">
                  {run.strategy}
                </Link>{' '}
                <span className="font-mono text-xs text-muted">{run.id.slice(0, 8)}</span>
              </h2>
              <StatusBadge value={run.status} />
            </div>
            <p className="mt-2 text-xs text-muted">
              capacity {run.configuration.capacity} · {run.configuration.concurrentUsers} buyers ×{' '}
              {run.configuration.quantityPerUser} seat(s) · seed {run.configuration.seed} ·{' '}
              {run.configuration.isolation}
              {run.strategy === 'unsafe_lab' ? ` · window delay ${run.configuration.artificialDelayMs}ms` : ''}
            </p>
          </div>
        ))}
      </div>

      <GroupedBars
        title="Outcome mix (counts from each run document)"
        categories={outcomeKeys.map((k) => k)}
        series={[
          { name: `${runA.strategy} ${runA.id.slice(0, 6)}`, color: SERIES_A, values: outcomeKeys.map((k) => runA.outcomes?.[k] ?? 0) },
          { name: `${runB.strategy} ${runB.id.slice(0, 6)}`, color: SERIES_B, values: outcomeKeys.map((k) => runB.outcomes?.[k] ?? 0) },
        ]}
      />

      <GroupedBars
        title="Latency percentiles (ms)"
        categories={['p50', 'p95', 'p99']}
        series={[
          { name: runA.strategy, color: SERIES_A, values: [runA.outcomes?.p50Ms, runA.outcomes?.p95Ms, runA.outcomes?.p99Ms].map((v) => v ?? 0) },
          { name: runB.strategy, color: SERIES_B, values: [runB.outcomes?.p50Ms, runB.outcomes?.p95Ms, runB.outcomes?.p99Ms].map((v) => v ?? 0) },
        ]}
      />

      <section className="space-y-3">
        <SectionLabel>Headline numbers</SectionLabel>
        <p className="text-xs text-muted">Verbatim from the stored outcomes.</p>
        <div className="overflow-hidden rounded-xl border border-edge">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-elevated text-left text-muted">
                <th scope="col" className="px-4 py-2.5 font-medium">Metric</th>
                <th scope="col" className="px-4 py-2.5 font-medium">{runA.strategy} {runA.id.slice(0, 6)}</th>
                <th scope="col" className="px-4 py-2.5 font-medium">{runB.strategy} {runB.id.slice(0, 6)}</th>
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
                <tr key={label} className="border-t border-edge">
                  <th scope="row" className="px-4 py-2.5 text-left font-normal text-muted">
                    {label}
                  </th>
                  <td className="px-4 py-2.5 tabular-nums">{get(runA)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{get(runB)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
