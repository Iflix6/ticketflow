import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { ErrorPanel } from '../../../../components/ErrorPanel';
import { ResultsTable } from '../../../../components/ResultsTable';
import { RunLiveProgress } from '../../../../components/RunLiveProgress';
import { PageHeader, SectionLabel, Stat, StatusBadge } from '../../../../components/ui';
import { Stagger } from '../../../../components/anim';
import type { ExperimentResultWire, LabRunDto } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

const fmt = (n: number | null | undefined, suffix = ''): string =>
  n === null || n === undefined ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let run: LabRunDto;
  let results: ExperimentResultWire[];
  try {
    const runRes = await serverApi<{ data: LabRunDto }>(`/api/v1/lab/runs/${id}`);
    run = runRes.data;
    const resultsRes = await serverApi<{ data: ExperimentResultWire[] }>(`/api/v1/lab/runs/${id}/results?limit=5000`);
    results = resultsRes.data;
  } catch (error) {
    return <ErrorPanel error={error} />;
  }

  const o = run.outcomes;
  // A run still in flight (only reachable for a `?mode=live` run) gets the streaming SSE panel; the server
  // refreshes to the immutable summary below the moment its terminal frame lands. A synchronous run's
  // navigation already happened after completion, so it never renders in this state.
  const inFlight = run.status === 'PENDING' || run.status === 'RUNNING';

  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <>
            Run <span className="font-mono text-base text-muted">{run.id.slice(0, 8)}</span>
          </>
        }
        subtitle={
          <>
            <span className="font-medium text-ink">{run.strategy}</span> · isolation {run.configuration.isolation} ·
            pool max {run.configuration.dbPoolMax} · seed {run.configuration.seed}
            <span className="mt-1 block text-xs text-muted">
              Started {new Date(run.startedAt).toLocaleString()}
              {run.finishedAt !== null ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ' · not finished'} ·
              environment {run.environment}
              {run.gitSha !== null ? ` @ ${run.gitSha.slice(0, 10)}` : ''}
            </span>
          </>
        }
        actions={<StatusBadge value={run.status} />}
      />

      {inFlight && (
        <div className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
          <RunLiveProgress runId={run.id} total={run.configuration.concurrentUsers} />
        </div>
      )}

      <section aria-labelledby="outcomes-heading" className="space-y-3">
        <SectionLabel id="outcomes-heading">Outcomes — server-aggregated</SectionLabel>
        {o === null ? (
          <p className="text-sm text-muted">This run has no aggregated outcomes yet (status {run.status}).</p>
        ) : (
          <>
            <Stagger as="dl" className="grid grid-cols-2 gap-3 sm:grid-cols-4" step={0.04}>
              {(
                [
                  ['Attempted', o.attempted],
                  ['Succeeded', o.succeeded],
                  ['Sold out', o.soldOut],
                  ['Conflict', o.conflict],
                  ['Duplicate', o.duplicate],
                  ['Validation error', o.validationError],
                  ['Server error', o.serverError],
                  ['Timeout', o.timeout],
                ] as const
              ).map(([label, value]) => (
                <Stat key={label} label={label} value={value.toLocaleString('en-US')} />
              ))}
            </Stagger>
            <Stagger as="dl" className="grid grid-cols-2 gap-3 sm:grid-cols-5" step={0.05} delay={0.1}>
              {(
                [
                  ['p50', fmt(o.p50Ms, ' ms')],
                  ['p95', fmt(o.p95Ms, ' ms')],
                  ['p99', fmt(o.p99Ms, ' ms')],
                  ['Throughput', fmt(o.throughputPerSecond, ' req/s')],
                  ['Duration', fmt(o.durationMs, ' ms')],
                ] as const
              ).map(([label, value]) => (
                <Stat key={label} label={label} value={value} />
              ))}
            </Stagger>
            <p className="text-sm">
              Invariant violations:{' '}
              {o.invariantViolations > 0 ? (
                <strong className="text-danger">{o.invariantViolations}</strong>
              ) : (
                <strong className="text-ok">0</strong>
              )}{' '}
              — computed by the runner against the fixture, not inferred from responses.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="results-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionLabel id="results-heading">Per-request results ({results.length} shown)</SectionLabel>
          <p className="text-sm text-muted">
            Export:{' '}
            <a href={`/api/v1/lab/runs/${run.id}/results?limit=5000`} className="text-brand underline underline-offset-2" download>
              raw JSON
            </a>
            {' · '}
            <a href={`/lab/runs/${run.id}/export`} className="text-brand underline underline-offset-2">
              CSV
            </a>
          </p>
        </div>
        <p className="text-xs text-muted">
          Limit is the documented maximum (5,000 rows); if the run attempted more, the table is a truncated view and
          the aggregates above remain the complete truth.{' '}
          <Link href="/lab" className="underline">
            ← All runs
          </Link>
        </p>
        <ResultsTable results={results} />
      </section>
    </div>
  );
}
