import { serverApi } from '../../../../lib/server-api';
import { ErrorPanel } from '../../../../components/ErrorPanel';
import { ResultsTable } from '../../../../components/ResultsTable';
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
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">
          Run <span className="font-mono text-lg">{run.id.slice(0, 8)}</span>
        </h1>
        <p className="text-sm text-slate-600">
          {run.strategy} · {run.status} · isolation {run.configuration.isolation} · pool max{' '}
          {run.configuration.dbPoolMax} · seed {run.configuration.seed}
        </p>
        <p className="text-xs text-slate-500">
          Started {new Date(run.startedAt).toLocaleString()}
          {run.finishedAt !== null ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ' · not finished'} ·
          environment {run.environment}
          {run.gitSha !== null ? ` @ ${run.gitSha.slice(0, 10)}` : ''}
        </p>
      </header>

      <section aria-labelledby="outcomes-heading" className="space-y-2">
        <h2 id="outcomes-heading" className="text-lg font-semibold">
          Outcomes (server-aggregated)
        </h2>
        {o === null ? (
          <p className="text-sm text-slate-600">This run has no aggregated outcomes yet (status {run.status}).</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
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
                <div key={label} className="rounded border border-slate-200 bg-white p-2">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-lg font-semibold">{value.toLocaleString('en-US')}</dd>
                </div>
              ))}
            </dl>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {(
                [
                  ['p50', fmt(o.p50Ms, ' ms')],
                  ['p95', fmt(o.p95Ms, ' ms')],
                  ['p99', fmt(o.p99Ms, ' ms')],
                  ['Throughput', fmt(o.throughputPerSecond, ' req/s')],
                  ['Duration', fmt(o.durationMs, ' ms')],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded border border-slate-200 bg-white p-2">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm">
              Invariant violations:{' '}
              {o.invariantViolations > 0 ? (
                <strong className="text-red-700">{o.invariantViolations}</strong>
              ) : (
                <strong className="text-green-800">0</strong>
              )}{' '}
              — computed by the runner against the fixture, not inferred from responses.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="results-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="results-heading" className="text-lg font-semibold">
            Per-request results ({results.length} shown)
          </h2>
          <p className="text-sm">
            Export: {' '}
            <a href={`/api/v1/lab/runs/${run.id}/results?limit=5000`} className="underline" download>
              raw JSON (documented endpoint)
            </a>
            {' · '}
            <a href={`/lab/runs/${run.id}/export`} className="underline">
              CSV via web route handler
            </a>
          </p>
        </div>
        <p className="text-xs text-slate-500">
          Limit is the documented maximum (5,000 rows); if the run attempted more, the table is a truncated view and
          the aggregates above remain the complete truth.
        </p>
        <ResultsTable results={results} />
      </section>
    </div>
  );
}
