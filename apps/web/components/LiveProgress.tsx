'use client';

import { useEffect, useRef, useState } from 'react';
import { labRunProgressUrl } from '../lib/api';
import type { LabRunProgressEvent } from '../lib/types';
import { Callout, Meter, SectionLabel, Stat, StatusBadge } from './ui';

/**
 * Live experiment progress via Server-Sent Events.
 *
 * This is the "live progress (SSE preferred)" surface of the spec. It is deliberately presentation-only:
 * every number it paints is a frame the SERVER emitted (a throttled tally from the runner, or the final
 * immutable summary in the terminal frame). It never recomputes availability or invents a metric — when a
 * frame says 37 of 100 attempts have landed, that is exactly what the runner reported. The authoritative
 * record remains the `experiment_runs` summary; on completion the parent refreshes/navigates to it.
 *
 * Honest limitations it handles rather than hides:
 *  - `EventSource` cannot set an `Authorization` header, so auth rides the first-party session cookie the
 *    `/api/v1` proxy already sends (`withCredentials`);
 *  - if the stream drops before a terminal frame (proxy buffering, reconnect cap), we say so and fall back
 *    to the parent instead of pretending the run is still visually live.
 */

type ProgressState = {
  phase: string;
  status: string;
  completed: number;
  total: number;
  succeeded: number;
  soldOut: number;
  conflict: number;
  duplicate: number;
  serverError: number;
  timeout: number;
};

type StreamState = 'connecting' | 'live' | 'done' | 'dropped';

export function LiveProgress({
  runId,
  total,
  onDone,
}: {
  runId: string;
  total: number;
  /** Called once when a terminal frame arrives (or the stream ends); parent refreshes or navigates. */
  onDone?: () => void;
}) {
  const [stream, setStream] = useState<StreamState>('connecting');
  const [progress, setProgress] = useState<ProgressState>({
    phase: 'queued',
    status: 'PENDING',
    completed: 0,
    total,
    succeeded: 0,
    soldOut: 0,
    conflict: 0,
    duplicate: 0,
    serverError: 0,
    timeout: 0,
  });
  // Keep the latest onDone in a ref so an EventSource that outlives a re-render still calls the current one.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const source = new EventSource(labRunProgressUrl(runId), { withCredentials: true });
    let sawTerminal = false;

    const finish = (): void => {
      sawTerminal = true;
      source.close();
      setStream('done');
      onDoneRef.current?.();
    };

    source.onopen = () => setStream('live');

    source.onmessage = (message: MessageEvent<string>) => {
      if (message.data === '[DONE]') {
        // Terminal sentinel; if we never parsed a summary/phase, treat completion as known from the server.
        finish();
        return;
      }
      let event: LabRunProgressEvent;
      try {
        event = JSON.parse(message.data) as LabRunProgressEvent;
      } catch {
        return; // a malformed frame must never crash the dashboard
      }
      if (event.type === 'phase') {
        setProgress((p) => ({ ...p, phase: event.phase, status: event.status }));
        if (event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'ABORTED') finish();
      } else if (event.type === 'tick') {
        setProgress((p) => ({
          ...p,
          phase: 'running',
          status: 'RUNNING',
          completed: event.completed,
          total: event.total || p.total,
          succeeded: event.succeeded,
          soldOut: event.soldOut,
          conflict: event.conflict,
          duplicate: event.duplicate,
          serverError: event.serverError,
          timeout: event.timeout,
        }));
      } else if (event.type === 'summary') {
        setProgress((p) => ({
          ...p,
          phase: 'completed',
          status: event.status,
          completed: event.outcomes.attempted,
          total: event.outcomes.attempted || p.total,
          succeeded: event.outcomes.succeeded,
          soldOut: event.outcomes.soldOut,
          conflict: event.outcomes.conflict,
          duplicate: event.outcomes.duplicate,
          serverError: event.outcomes.serverError,
          timeout: event.outcomes.timeout,
        }));
        finish();
      }
    };

    source.onerror = () => {
      // EventSource retries on its own while CONNECTING/OPEN. Only a genuinely CLOSED socket (or a terminal
      // already handled above) should stop us; anything else is a transient blip we let it recover from.
      if (source.readyState === EventSource.CLOSED && !sawTerminal) {
        setStream('dropped');
        onDoneRef.current?.();
      }
    };

    return () => {
      if (!sawTerminal) source.close();
    };
  }, [runId]);

  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <section aria-labelledby="live-progress-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel id="live-progress-heading">Live progress (server-streamed)</SectionLabel>
        <StatusBadge value={progress.status} />
      </div>

      <Meter value={progress.completed} max={progress.total} label={`Attempted ${progress.completed} of ${progress.total} (${pct}%)`} />

      <div aria-live="polite" role="status" className="sr-only">
        {stream === 'connecting' ? 'Connecting to the run progress stream.' : `Phase ${progress.phase}, ${progress.completed} of ${progress.total} attempted.`}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Succeeded" value={progress.succeeded.toLocaleString('en-US')} tone="ok" />
        <Stat label="Sold out" value={progress.soldOut.toLocaleString('en-US')} tone="warn" />
        <Stat label="Conflict" value={progress.conflict.toLocaleString('en-US')} tone={progress.conflict > 0 ? 'warn' : 'default'} />
        <Stat label="Server error" value={progress.serverError.toLocaleString('en-US')} tone={progress.serverError > 0 ? 'danger' : 'default'} />
      </dl>

      {stream === 'dropped' && (
        <div role="alert">
          <Callout tone="warn">
            The live stream ended before the run reported a terminal status. The experiment may still be
            running in the background — reload this page (or check the run history) for the authoritative result.
          </Callout>
        </div>
      )}
      {stream === 'done' && (
        <Callout tone="info">Run finished. Loading the authoritative, server-aggregated summary…</Callout>
      )}
    </section>
  );
}
