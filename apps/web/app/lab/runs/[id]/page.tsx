import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { ErrorPanel } from '../../../../components/ErrorPanel';
import { ResultsTable } from '../../../../components/ResultsTable';
import { PageHeader, SectionLabel, Stat, StatusBadge } from '../../../../components/ui';
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

      <section aria-labelledby="outcomes-heading" className="space-y-3">
        <SectionLabel id="outcomes-heading">Outcomes — server-aggregated</SectionLabel>
        {o === null ? (
          <p className="text-sm text-muted">This run has no aggregated outcomes yet (status {run.status}).</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            </dl>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
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
            </dl>
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
