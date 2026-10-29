import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { FixtureResetButton } from '../../../components/FixtureResetButton';
import type { StrategyDescriptorDto } from '../../../lib/types';

export const dynamic = 'force-dynamic';

/**
 * Architecture explanation, straight from the server: each descriptor's `sql` field is the EXACT
 * allocation statement the runner executes (the strategies module builds the descriptor from the
 * same constants it runs — the page cannot beautify what the database does). Tradeoffs are the
 * API's own bullet list. Nothing here is written by the UI team.
 */
export default async function StrategiesPage() {
  let strategies: StrategyDescriptorDto[];
  try {
    const res = await serverApi<{ data: StrategyDescriptorDto[] }>('/api/v1/lab/strategies');
    strategies = res.data;
  } catch (error) {
    return <ErrorPanel error={error} />;
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Strategies &amp; SQL</h1>
      <p className="max-w-3xl text-sm text-slate-600">
        Four allocation strategies share one fixture. The first three are safe under concurrency by
        different mechanisms; the fourth is the deliberate bug — it exists so the dashboard can show a
        REAL oversell with recorded invariant violations, never a staged one.
      </p>

      <div className="space-y-4">
        {strategies.map((s) => (
          <article key={s.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <header className="flex flex-wrap items-baseline gap-3">
              <h2 className="font-semibold">{s.label}</h2>
              <code className="font-mono text-xs text-slate-500">{s.id}</code>
              <span
                className={
                  s.safe
                    ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-900'
                    : 'rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900'
                }
              >
                {s.safe ? 'safe' : 'UNSAFE — oversells by design'}
              </span>
              {s.labOnly && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">lab-only (never in a real deployment)</span>
              )}
            </header>
            <p className="mt-2 text-sm">{s.summary}</p>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Allocation SQL (verbatim from the API)</h3>
            <pre className="mt-1 overflow-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
              <code>{s.sql}</code>
            </pre>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Tradeoffs</h3>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm">
              {s.tradeoffs.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section aria-labelledby="fixture-heading" className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 id="fixture-heading" className="font-semibold">Lab fixture</h2>
        <p className="mt-1 text-sm text-slate-600">
          Runs reset the fixture themselves as their first step (seeded, deterministic). The button
          below calls the documented <code className="font-mono text-xs">POST /lab/fixtures/reset</code> for when you
          want a clean slate without launching an experiment.
        </p>
        <FixtureResetButton />
      </section>
    </div>
  );
}
