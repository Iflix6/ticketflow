import type {
  ExperimentOutcome,
  FailureClassification,
  LabRunConfiguration,
  LabRunDto,
  StrategyId,
} from '@ticketflow/contracts';
import type { Database, SqlClient } from '../../db/pool.js';
import type { AppConfig } from '@ticketflow/config';
import { ISOLATION_LEVELS, timeoutsFrom, withTransaction } from '../../db/transaction.js';
import { isPgError } from '../../shared/errors.js';
import type { Logger } from '../../observability/logger.js';
import { appMetrics } from '../../observability/metrics.js';
import { labInvariantViolations } from './repository.js';

/**
 * Experiment runner (LOCAL/TEST ONLY — ADR-0009).
 *
 * This is the ONLY code path allowed to write the isolated `lab` schema, and the ONLY place the
 * intentionally unsafe baseline exists. It is a focused allocation-contention harness: it drives N
 * concurrent single-tier reservations against `lab.inventory` using the selected strategy, times each
 * attempt, classifies every outcome, and then measures the final state with the SAME over-allocation
 * view the safe path is judged by (`lab.live_allocation_violations`). Nothing here touches public
 * inventory, idempotency, or the checkout flow — those are exercised end-to-end through the real
 * reservation service, not re-simulated at the lab layer.
 *
 * The four strategies differ ONLY in the guard around the read-modify-write:
 *   A atomic_update : test-and-mutate in one guarded UPDATE (the WHERE clause is the linearization point)
 *   B pessimistic   : `SELECT ... FOR UPDATE` then decide then write (lock first)
 *   C optimistic    : compare-and-set on `version`, bounded retry with jitter (conflict != sold out)
 *   unsafe_lab      : UNLOCKED read → artificial delay → blind write of stale-derived values (no guard)
 */

type AttemptOutcome = { outcome: ExperimentOutcome; failureClass: FailureClassification };

export type AttemptRecord = {
  requestIndex: number;
  actorLabel: string;
  outcome: ExperimentOutcome;
  httpStatus: number | null;
  latencyMicros: number;
  failureClass: FailureClassification;
  correlationId: string;
};

export type RunSummary = NonNullable<LabRunDto['outcomes']>;

export type RunOutcome = {
  attempts: AttemptRecord[];
  summary: RunSummary;
  invariantViolations: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic 32-bit PRNG (mulberry32) so jitter is reproducible for a given seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HTTP_FOR_OUTCOME: Record<ExperimentOutcome, number> = {
  SUCCEEDED: 201,
  SOLD_OUT: 409,
  CONFLICT: 409,
  DUPLICATE: 200,
  VALIDATION_ERROR: 400,
  SERVER_ERROR: 500,
  TIMEOUT: 503,
};

/** Maps a thrown value onto the taxonomy without leaking driver text (mirrors the API's own rules). */
function classifyThrown(error: unknown): AttemptOutcome {
  const code = isPgError(error) ? error.code : undefined;
  switch (code) {
    case '40001':
    case '55P03':
      return { outcome: 'CONFLICT', failureClass: 'unknown' };
    case '40P01':
      return { outcome: 'CONFLICT', failureClass: 'deadlock' };
    case '23514':
      return { outcome: 'SERVER_ERROR', failureClass: 'invariant_violation_failed_insert' };
    case '23505':
      return { outcome: 'DUPLICATE', failureClass: 'duplicate_booking' };
    case '57014':
      return { outcome: 'TIMEOUT', failureClass: 'timeout' };
    default:
      return { outcome: 'SERVER_ERROR', failureClass: 'unknown' };
  }
}

export class ExperimentRunner {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Runs one experiment: `concurrentUsers` attempts against tier `tierId`, each reserving
   * `quantityPerUser` seats, using `strategy`. Attempts fire as close together as the process allows
   * (rampMs = 0 is a barrier start), bounded to `dbPoolMax` in-flight lanes so a huge fan-out queues on
   * the connection pool instead of exhausting it.
   */
  async run(strategy: StrategyId, configuration: LabRunConfiguration, tierId: string): Promise<RunOutcome> {
    const { concurrentUsers, quantityPerUser, reservationTtlSeconds, artificialDelayMs, rampMs, seed, dbPoolMax, isolation } =
      configuration;
    const random = seededRandom(seed);
    const lanes = Math.max(1, Math.min(concurrentUsers, dbPoolMax));
    const isolationLevel =
      isolation === 'serializable'
        ? ISOLATION_LEVELS.serializable
        : isolation === 'repeatable_read'
          ? ISOLATION_LEVELS.repeatableRead
          : ISOLATION_LEVELS.readCommitted;

    const startedAt = process.hrtime.bigint();
    const attempts: AttemptRecord[] = new Array<AttemptRecord>(concurrentUsers);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= concurrentUsers) return;
        // Barrier start (rampMs 0) fires together; a linear ramp staggers starts across the window.
        if (rampMs > 0) await sleep(Math.floor((index / concurrentUsers) * rampMs));

        const actorLabel = `buyer-${String(index).padStart(4, '0')}`;
        const attemptStarted = process.hrtime.bigint();
        let result: AttemptOutcome;
        try {
          result = await this.attempt(strategy, tierId, actorLabel, quantityPerUser, reservationTtlSeconds, artificialDelayMs, random, isolationLevel);
        } catch (error) {
          result = classifyThrown(error);
        }
        const latencyMicros = Number(process.hrtime.bigint() - attemptStarted) / 1000;
        attempts[index] = {
          requestIndex: index,
          actorLabel,
          outcome: result.outcome,
          httpStatus: HTTP_FOR_OUTCOME[result.outcome],
          latencyMicros,
          failureClass: result.failureClass,
          correlationId: `${tierId}:${index}`,
        };
        appMetrics.experimentRequests.inc({ strategy, outcome: result.outcome });
      }
    };

    await Promise.all(Array.from({ length: lanes }, () => worker()));
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const invariantViolations = await labInvariantViolations(this.db);
    const summary = this.summarize(attempts.filter((a): a is AttemptRecord => a !== undefined), durationMs, invariantViolations);
    this.logger.debug({ strategy, attempted: concurrentUsers, succeeded: summary.succeeded, invariantViolations }, 'experiment run complete');
    return { attempts, summary, invariantViolations };
  }

  private attempt(
    strategy: StrategyId,
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
    delayMs: number,
    random: () => number,
    isolation: (typeof ISOLATION_LEVELS)[keyof typeof ISOLATION_LEVELS],
  ): Promise<AttemptOutcome> {
    const options = { label: `lab.reserve.${strategy}`, isolation, timeouts: timeoutsFrom(this.config) };
    if (strategy === 'unsafe_lab') {
      // The unsafe baseline is NOT wrapped in a transaction: that is the whole demonstration.
      return this.attemptUnsafe(tierId, actorLabel, quantity, ttlSeconds, delayMs);
    }
    if (strategy === 'pessimistic') {
      return withTransaction(this.db, options, (client) => this.reservePessimistic(client, tierId, actorLabel, quantity, ttlSeconds));
    }
    if (strategy === 'optimistic') {
      return withTransaction(this.db, options, (client) => this.reserveOptimistic(client, tierId, actorLabel, quantity, ttlSeconds, random));
    }
    return withTransaction(this.db, options, (client) => this.reserveAtomic(client, tierId, actorLabel, quantity, ttlSeconds));
  }

  private async insertReservation(
    client: SqlClient,
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
    strategy: StrategyId,
  ): Promise<void> {
    await client.query(
      `INSERT INTO lab.reservations (id, tier_id, actor_label, quantity, status, strategy, expires_at)
       VALUES (app.new_id(), $1, $2, $3, 'PENDING', $4, app.now() + make_interval(secs => $5::int))`,
      [tierId, actorLabel, quantity, strategy, ttlSeconds],
    );
  }

  // Safe A — test-and-mutate in a single guarded statement.
  private async reserveAtomic(
    client: SqlClient,
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
  ): Promise<AttemptOutcome> {
    const updated = await client.query(
      `UPDATE lab.inventory
          SET available = available - $2, reserved = reserved + $2, version = version + 1
        WHERE tier_id = $1 AND available >= $2`,
      [tierId, quantity],
    );
    if ((updated.rowCount ?? 0) === 0) return { outcome: 'SOLD_OUT', failureClass: 'none' };
    await this.insertReservation(client, tierId, actorLabel, quantity, ttlSeconds, 'atomic_update');
    return { outcome: 'SUCCEEDED', failureClass: 'none' };
  }

  // Safe B — lock the row, decide from the stable snapshot, then write.
  private async reservePessimistic(
    client: SqlClient,
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
  ): Promise<AttemptOutcome> {
    const locked = await client.query<{ available: number }>(
      `SELECT available FROM lab.inventory WHERE tier_id = $1 FOR UPDATE`,
      [tierId],
    );
    const snapshot = locked.rows[0];
    if (snapshot === undefined) throw new Error(`lab inventory row missing for tier ${tierId}`);
    if (snapshot.available < quantity) return { outcome: 'SOLD_OUT', failureClass: 'none' };
    await client.query(
      `UPDATE lab.inventory SET available = available - $2, reserved = reserved + $2, version = version + 1 WHERE tier_id = $1`,
      [tierId, quantity],
    );
    await this.insertReservation(client, tierId, actorLabel, quantity, ttlSeconds, 'pessimistic');
    return { outcome: 'SUCCEEDED', failureClass: 'none' };
  }

  // Safe C — compare-and-set on version, bounded retry with jitter; conflict is distinct from sold out.
  private async reserveOptimistic(
    client: SqlClient,
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
    random: () => number,
  ): Promise<AttemptOutcome> {
    const maxAttempts = this.config.TX_MAX_ATTEMPTS + 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = await client.query<{ available: number; version: number }>(
        `SELECT available, version FROM lab.inventory WHERE tier_id = $1`,
        [tierId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error(`lab inventory row missing for tier ${tierId}`);
      if (row.available < quantity) return { outcome: 'SOLD_OUT', failureClass: 'none' };
      const updated = await client.query(
        `UPDATE lab.inventory
            SET available = available - $3, reserved = reserved + $3, version = version + 1
          WHERE tier_id = $1 AND version = $2 AND available >= $3`,
        [tierId, row.version, quantity],
      );
      if ((updated.rowCount ?? 0) > 0) {
        await this.insertReservation(client, tierId, actorLabel, quantity, ttlSeconds, 'optimistic');
        return { outcome: 'SUCCEEDED', failureClass: 'none' };
      }
      if (attempt < maxAttempts) await sleep(Math.floor(random() * 5));
    }
    return { outcome: 'CONFLICT', failureClass: 'none' };
  }

  // Unsafe baseline — the demonstration. Unlocked read, delay inside the window, blind stale write.
  private async attemptUnsafe(
    tierId: string,
    actorLabel: string,
    quantity: number,
    ttlSeconds: number,
    delayMs: number,
  ): Promise<AttemptOutcome> {
    // 1. Read counters with NO lock and NO transaction — the snapshot can be stale the instant we look away.
    const read = await this.db.query<{ available: number; reserved: number }>(
      'SELECT available, reserved FROM lab.inventory WHERE tier_id = $1',
      [tierId],
    );
    const snapshot = read.rows[0];
    if (snapshot === undefined) throw new Error(`lab inventory row missing for tier ${tierId}`);
    // 2. The application "decides" it can sell — a decision that is already out of date by the time we act.
    if (snapshot.available < quantity) return { outcome: 'SOLD_OUT', failureClass: 'none' };
    // 3. Artificial latency widens the read-modify-write window so a real anomaly is visible, not assumed.
    if (delayMs > 0) await sleep(delayMs);
    try {
      // 4. Blind write of values computed from the STALE read: two buyers who both saw `available = N`
      //    both write `available = N - qty`, so one decrement is lost. The partition CHECK still holds
      //    (the sum is preserved), which is exactly why the anomaly must be judged by the over-allocation
      //    VIEW, not by a single-row constraint.
      await this.db.query(
        `UPDATE lab.inventory SET available = $2, reserved = $3, version = version + 1 WHERE tier_id = $1`,
        [tierId, snapshot.available - quantity, snapshot.reserved + quantity],
      );
      await this.db.query(
        `INSERT INTO lab.reservations (id, tier_id, actor_label, quantity, status, strategy, expires_at)
         VALUES (app.new_id(), $1, $2, $3, 'PENDING', 'unsafe_lab', app.now() + make_interval(secs => $4::int))`,
        [tierId, actorLabel, quantity, ttlSeconds],
      );
      return { outcome: 'SUCCEEDED', failureClass: 'lost_update_overallocation' };
    } catch (error) {
      // If a constraint does reject a write, classify the failure honestly rather than calling it a sale.
      return classifyThrown(error);
    }
  }

  private summarize(attempts: AttemptRecord[], durationMs: number, invariantViolations: number): RunSummary {
    const count = (outcome: ExperimentOutcome): number => attempts.filter((a) => a.outcome === outcome).length;
    const latencies = attempts.map((a) => a.latencyMicros).sort((x, y) => x - y);
    const percentile = (p: number): number | null => {
      if (latencies.length === 0) return null;
      const index = Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1));
      return Number(((latencies[index] ?? 0) / 1000).toFixed(3));
    };
    const seconds = durationMs / 1000;
    return {
      attempted: attempts.length,
      succeeded: count('SUCCEEDED'),
      soldOut: count('SOLD_OUT'),
      conflict: count('CONFLICT'),
      duplicate: count('DUPLICATE'),
      validationError: count('VALIDATION_ERROR'),
      serverError: count('SERVER_ERROR'),
      timeout: count('TIMEOUT'),
      throughputPerSecond: seconds > 0 ? Number((attempts.length / seconds).toFixed(2)) : null,
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      p99Ms: percentile(99),
      durationMs: Math.round(durationMs),
      invariantViolations,
    };
  }
}
