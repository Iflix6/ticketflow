import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { ScenarioForm } from '../../../components/ScenarioForm';
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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Scenario builder</h1>
      <p className="text-sm text-slate-600">
        The form validates against the SAME <code className="font-mono text-xs">labRunConfigurationSchema</code>{' '}
        the API enforces, and the payload is the schema&apos;s parsed output — bounds below come from that schema,
        not from prose. <strong>Launching a run holds this request open until the experiment finishes</strong> (
        <code className="font-mono text-xs">POST /lab/runs</code> is synchronous by design): a 1,000-buyer run
        takes seconds, a 5,000-user run longer. The response IS the completed run.
      </p>
      <ScenarioForm strategies={strategies} />
    </div>
  );
}
