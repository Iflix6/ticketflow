import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { FixtureResetButton } from '../../../components/FixtureResetButton';
import { PageHeader, SectionLabel, Badge } from '../../../components/ui';
import { Stagger } from '../../../components/anim';
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
    <div className="space-y-6">
      <PageHeader
        title="Strategies & SQL"
        subtitle="Four allocation strategies share one fixture. The first three are safe under concurrency by different mechanisms; the fourth is the deliberate bug — it exists so the dashboard can show a REAL oversell with recorded invariant violations, never a staged one."
      />

      <Stagger as="div" className="space-y-4" step={0.08}>
        {strategies.map((s) => (
          <article key={s.id} className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
            <header className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-lg font-semibold">{s.label}</h2>
              <code className="rounded bg-elevated px-2 py-0.5 font-mono text-xs text-muted">{s.id}</code>
              <span className="ml-auto flex items-center gap-2">
                {s.labOnly && <Badge tone="neutral">lab-only (never deployed)</Badge>}
                {s.safe ? <Badge tone="ok">safe</Badge> : <Badge tone="danger">UNSAFE — oversells by design</Badge>}
              </span>
            </header>
            <p className="mt-3 text-sm text-muted">{s.summary}</p>

            <div className="mt-4 space-y-1">
              <SectionLabel>Allocation SQL — verbatim from the API</SectionLabel>
              <pre className="tf-scroll overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100 ring-1 ring-edge">
                <code>{s.sql}</code>
              </pre>
            </div>

            <div className="mt-4 space-y-1">
              <SectionLabel>Tradeoffs</SectionLabel>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm">
                {s.tradeoffs.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </Stagger>

      <section aria-labelledby="fixture-heading" className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
        <h2 id="fixture-heading" className="text-lg font-semibold">Lab fixture</h2>
        <p className="mt-1 text-sm text-muted">
          Runs reset the fixture themselves as their first step (seeded, deterministic). The button
          below calls the documented <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">POST /lab/fixtures/reset</code> for when you
          want a clean slate without launching an experiment.
        </p>
        <FixtureResetButton />
      </section>
    </div>
  );
}
