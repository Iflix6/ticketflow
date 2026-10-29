import Link from 'next/link';
import { serverApi, isApiCallError } from '../../lib/server-api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import { CompareSelector } from '../../components/CompareSelector';
import type { LabRunDto, Pagination } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function LabRunsPage() {
  let runs: LabRunDto[];
  let pagination: Pagination;
  try {
    const res = await serverApi<{ data: LabRunDto[]; pagination: Pagination }>('/api/v1/lab/runs?page=1&pageSize=25');
    runs = res.data;
    pagination = res.pagination;
  } catch (error) {
    if (isApiCallError(error) && error.status === 401) {
      // Honest middle state: the layout guard passed minutes ago but the session died since.
      return <p role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">Your session expired or was revoked — sign in again to list runs.</p>;
    }
    return <ErrorPanel error={error} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Experiment runs</h1>
        <Link href="/lab/scenario" className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800">
          New run
        </Link>
      </div>
      <p className="text-sm text-slate-600">
        {pagination.totalItems} run(s) recorded; showing page {pagination.page} of {pagination.totalPages}. Completed
        runs are immutable — the TF002 trigger rejects edits, so this table can be trusted as history.
      </p>

      {runs.length === 0 ? (
        <EmptyState>
          No experiments yet.{' '}
          <Link href="/lab/scenario" className="underline">
            Launch the first run
          </Link>{' '}
          — e.g. unsafe_lab vs 100 tickets to see a real oversell.
        </EmptyState>
      ) : (
        <CompareSelector runs={runs} />
      )}
    </div>
  );
}
