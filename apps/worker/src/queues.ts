import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import type { Pool } from './db.js';
import { expireOneReservation, processOutboxJob } from './consumers.js';
import type { Dispatcher, OutboxJobData } from './outbox.js';

/**
 * BullMQ topology (ADR-0005). Every business event flows through the `outbox-dispatch` queue; expiry
 * fast-path jobs go to `reservation-expiry`. Both have a paired `*-dead` queue that a job lands in
 * only after its retry budget is exhausted, so poison messages are parked for inspection instead of
 * burning CPU forever. Concurrency and attempts are capped by configuration, never hard-coded.
 */

export const QUEUE = {
  dispatch: 'outbox-dispatch',
  dispatchDead: 'outbox-dispatch-dead',
  expiry: 'reservation-expiry',
  expiryDead: 'reservation-expiry-dead',
} as const;

/** Parses a `redis://` URL into BullMQ connection options. `maxRetriesPerRequest: null` is required. */
export function redisOptionsFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const options: ConnectionOptions = {
    host: u.hostname,
    port: u.port === '' ? 6379 : Number(u.port),
    maxRetriesPerRequest: null,
  };
  if (u.username !== '') options.username = decodeURIComponent(u.username);
  if (u.password !== '') options.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db !== '') options.db = Number(db);
  return options;
}

/**
 * Finished-job retention. Deliberately BOUNDED, not `false` ("keep forever"): an ever-growing
 * completed set is a guaranteed Redis OOM in a long-running system. The window only has to outlast the
 * relay's retry cadence (poll every `OUTBOX_POLL_MS`), and one hour of history is ample for a
 * post-mortem. Failed jobs are kept far longer because a dead-letter is a human inspection artifact.
 *
 * Typed as our own `BoundedRetention` rather than BullMQ's `KeepJobs` on purpose: `KeepJobs` is a union
 * of `{ count }` and `{ age; count?; limit? }`, so the count-only branch is legal there and `.age` is not
 * even readable on it. Requiring BOTH is the invariant we want to hold (and to assert in tests), and it is
 * still assignable to `KeepJobs`. Two facts about how the age branch actually executes, from BullMQ's own
 * docs, that matter for reasoning about jobId dedup: cleanup is best-effort and only evaluated when a
 * *later* job of the same kind finishes — so an aged record can linger until the next completion. That
 * makes the dedup window slightly more generous than configured, never shorter.
 */
type BoundedRetention = { age: number; count: number };
const KEEP_COMPLETED: BoundedRetention = { age: 3600, count: 1000 };
const KEEP_FAILED: BoundedRetention = { age: 7 * 24 * 3600, count: 1000 };

/** Per-job defaults: bounded retries with jittered exponential backoff; finished jobs kept for inspection. */
export function jobDefaults(maxAttempts: number): {
  attempts: number;
  backoff: { type: 'exponential'; delay: number; jitter: number };
  removeOnComplete: BoundedRetention;
  removeOnFail: BoundedRetention;
} {
  return {
    attempts: maxAttempts,
    // Jitter matters here: a worker that momentarily loses Redis sees every in-flight job fail at once,
    // and identical delays would make them all retry at once too. NOTE the units: BullMQ's `jitter` is a
    // FRACTION of the delay (validated 0..1) even though its own docstring calls it a percentage — the
    // same trap as the forbidden ':' in job ids. Writing `50` here throws on every single add().
    backoff: { type: 'exponential', delay: 250, jitter: 0.5 },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

export interface QueueBundle {
  dispatch: Queue<OutboxJobData>;
  expiry: Queue<{ reservationId: string }>;
  dispatchDead: Queue;
  expiryDead: Queue;
  close(): Promise<void>;
}

export function createQueues(connection: ConnectionOptions, maxAttempts: number, prefix?: string): QueueBundle {
  const defaults = jobDefaults(maxAttempts);
  const dispatch = new Queue<OutboxJobData>(QUEUE.dispatch, { connection, defaultJobOptions: defaults, ...(prefix ? { prefix } : {}) });
  const expiry = new Queue<{ reservationId: string }>(QUEUE.expiry, { connection, defaultJobOptions: defaults, ...(prefix ? { prefix } : {}) });
  const dispatchDead = new Queue(QUEUE.dispatchDead, { connection, ...(prefix ? { prefix } : {}) });
  const expiryDead = new Queue(QUEUE.expiryDead, { connection, ...(prefix ? { prefix } : {}) });
  return {
    dispatch,
    expiry,
    dispatchDead,
    expiryDead,
    close: async () => {
      await Promise.all([dispatch.close(), expiry.close(), dispatchDead.close(), expiryDead.close()]);
    },
  };
}

/**
 * Deterministic job ids. Both MUST stay colon-free: BullMQ's `Job.validateOptions` rejects any custom
 * job id containing ':' and the whole delivery path would throw on every event. Kept as exported
 * helpers so `tests/unit/queue-job-options.test.ts` can pin the rule without a live Redis.
 */
export const dispatchJobId = (outboxId: string): string => `outbox-${outboxId}`;
export const expiryJobId = (reservationId: string): string => `expiry-${reservationId}`;

/** Production dispatcher: adds to the dispatch queue keyed by a deterministic job id derived from the outbox id. */
export class BullMQDispatcher implements Dispatcher {
  constructor(private readonly queue: Queue<OutboxJobData>) {}

  async dispatch(job: OutboxJobData): Promise<void> {
    // jobId = outbox id. Measured against BullMQ 6.5 (`worker-recovery.test.ts`): while the job RECORD
    // exists — pending OR completed — `add` with the same id creates no second run, which is exactly
    // what the relay's crash-between-dispatch-and-mark retry needs. Two traps learned the hard way:
    //  1. custom job ids MUST NOT contain ':' — `Job.validateOptions` throws, which would fail EVERY
    //     dispatch and silently freeze all delivery (the relay would just keep re-logging errors).
    //  2. the dedup lasts only as long as retention does (see jobDefaults), and `add` resolves to the
    //     pre-existing job so it cannot even be reported. Beyond the window a re-add WOULD create a
    //     fresh run — harmless, because the consumer's `consumed_events` marker, not this id, is the
    //     load-bearing exactly-once guarantee.
    await this.queue.add('outbox', job, { jobId: dispatchJobId(job.outboxId) });
  }
}

export interface WorkerHandle {
  dispatch: Worker<OutboxJobData>;
  expiry: Worker<{ reservationId: string }>;
  close(): Promise<void>;
}

/**
 * Starts the two consumers. A final-attempt failure moves the job to the matching dead queue (and logs
 * `job.id`), so nothing is retried indefinitely and every parked poison message is inspectable.
 */
export function startWorkers(
  queues: QueueBundle,
  connection: ConnectionOptions,
  pool: Pool,
  options: { concurrency: number; maxAttempts: number; log: (msg: string, ctx?: Record<string, unknown>) => void; prefix?: string },
): WorkerHandle {
  const dispatch = new Worker<OutboxJobData>(
    QUEUE.dispatch,
    async (job) => {
      await processOutboxJob(pool, job.data, {
        // Best-effort by design: a scheduling failure is logged, never allowed to fail the delivery
        // attempt, because the periodic sweeper remains the expiry truth path (ADR-0005).
        onReservationCreated: async (reservationId) => {
          try {
            await queues.expiry.add('expire', { reservationId }, { jobId: expiryJobId(reservationId) });
          } catch (error) {
            options.log('expiry fast-path schedule failed; sweeper still covers it', {
              reservationId,
              error: String(error),
            });
          }
        },
      });
      return { outboxId: job.data.outboxId };
    },
    { connection, concurrency: options.concurrency, ...(options.prefix ? { prefix: options.prefix } : {}) },
  );

  const expiry = new Worker<{ reservationId: string }>(
    QUEUE.expiry,
    async (job) => {
      const expired = await expireOneReservation(pool, job.data.reservationId);
      return { expired };
    },
    { connection, concurrency: options.concurrency, ...(options.prefix ? { prefix: options.prefix } : {}) },
  );

  dispatch.on('failed', (job: Job<OutboxJobData> | undefined, error: Error) => {
    void moveToDead(queues.dispatchDead, options.maxAttempts, job, error, options.log, 'dispatch');
  });
  expiry.on('failed', (job: Job<{ reservationId: string }> | undefined, error: Error) => {
    void moveToDead(queues.expiryDead, options.maxAttempts, job, error, options.log, 'expiry');
  });

  return {
    dispatch,
    expiry,
    close: async () => {
      await Promise.all([dispatch.close(), expiry.close()]);
    },
  };
}

async function moveToDead(
  deadQueue: Queue,
  maxAttempts: number,
  job: Job | undefined,
  error: Error,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
  lane: string,
): Promise<void> {
  if (job === undefined) return;
  if (job.attemptsMade < maxAttempts) {
    log('job failed, will retry', { lane, jobId: job.id, attempt: job.attemptsMade, error: error.message });
    return;
  }
  log('job exhausted retries -> dead-letter', { lane, jobId: job.id, error: error.message });
  await deadQueue.add(job.name, job.data).catch((addError: unknown) =>
    log('dead-letter add failed', { lane, jobId: job.id, error: String(addError) }));
}
