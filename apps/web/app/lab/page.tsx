import Link from 'next/link';
import { serverApi, isApiCallError } from '../../lib/server-api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import { CompareSelector } from '../../components/CompareSelector';
import { PageHeader, buttonClass } from '../../components/ui';
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
      return (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          Your session expired or was revoked — sign in again to list runs.
        </div>
      );
    }
    return <ErrorPanel error={error} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experiment runs"
        subtitle={
          <>
            {pagination.totalItems} run(s) recorded; showing page {pagination.page} of {pagination.totalPages}. Completed
            runs are immutable — the TF002 trigger rejects edits, so this table can be trusted as history.
          </>
        }
        actions={
          <Link href="/lab/scenario" className={buttonClass('primary', 'sm')}>
            New run
          </Link>
        }
      />

      {runs.length === 0 ? (
        <EmptyState>
          No experiments yet.{' '}
          <Link href="/lab/scenario" className="font-medium text-brand underline underline-offset-2">
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
