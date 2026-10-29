import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { ScenarioForm } from '../../../components/ScenarioForm';
import { PageHeader } from '../../../components/ui';
import type { StrategyDescriptorDto } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export default async function NewRunPage() {
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
        title="Scenario builder"
        subtitle={
          <>
            The form validates against the SAME <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">labRunConfigurationSchema</code>{' '}
            the API enforces, and the payload is the schema&apos;s parsed output — bounds below come from that schema,
            not from prose. <strong className="text-ink">Launching a run holds this request open until the experiment finishes</strong> (
            <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">POST /lab/runs</code> is synchronous by design): a 1,000-buyer run
            takes seconds, a 5,000-user run longer. The response IS the completed run.
          </>
        }
      />
      <ScenarioForm strategies={strategies} />
    </div>
  );
}
