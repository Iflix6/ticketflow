'use client';

import { useRouter } from 'next/navigation';
import { LiveProgress } from './LiveProgress';

/**
 * Client island for the run-detail Server Component. A run opened while still PENDING/RUNNING (only
 * possible for a `?mode=live` run, since a synchronous run's detail navigation happens AFTER completion)
 * streams live progress here; on the terminal frame we `router.refresh()` so the server re-fetches the now
 * immutable `experiment_runs` summary and the authoritative table replaces this provisional one.
 */
export function RunLiveProgress({ runId, total }: { runId: string; total: number }) {
  const router = useRouter();
  return <LiveProgress runId={runId} total={total} onDone={() => router.refresh()} />;
}
