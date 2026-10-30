import type { LabRunProgressEvent } from '@ticketflow/contracts';

/**
 * In-process live-progress bus for lab runs (LOCAL/TEST ONLY — ADR-0009).
 *
 * The runner records per-attempt results only at the END of a run (one batch insert), and the
 * `experiment_runs` row is immutable once finalized — so a client polling the database cannot observe a
 * fine-grained "attempt 37 of 100" tick while the fan-out is in flight. This bus is the missing channel:
 * the asynchronous run publishes progress frames as they happen, and the SSE handler subscribes and
 * relays them. It is deliberately per-process and in-memory because the lab is a single local worker
 * running its own experiment; there is no cross-process fan-out to build (and no invented durability).
 *
 * Two safety properties the streaming path relies on:
 *  - a listener that throws is never allowed to disturb the run or the other listeners;
 *  - publishing to a run nobody watches is a no-op, so the runner can emit unconditionally.
 */

type ProgressListener = (event: LabRunProgressEvent) => void;

const channels = new Map<string, Set<ProgressListener>>();

/** Registers `listener` for `runId`; returns the unsubscribe function the SSE caller MUST call on close. */
export function subscribeProgress(runId: string, listener: ProgressListener): () => void {
  let listeners = channels.get(runId);
  if (listeners === undefined) {
    listeners = new Set<ProgressListener>();
    channels.set(runId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = channels.get(runId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) channels.delete(runId);
  };
}

/** Emits `event` to every live subscriber of `runId`; a terminal frame is simply an event like any other. */
export function publishProgress(runId: string, event: LabRunProgressEvent): void {
  const listeners = channels.get(runId);
  if (listeners === undefined || listeners.size === 0) return;
  // Copy before iterating: a listener may unsubscribe (ending its stream) re-entrantly.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // Never let a broken consumer socket destabilize the experiment producing its frames.
    }
  }
}

/** True while at least one SSE client is watching — kept for debug logging and future back-pressure. */
export function hasProgressSubscribers(runId: string): boolean {
  return (channels.get(runId)?.size ?? 0) > 0;
}
