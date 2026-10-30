import type { LabRunConfiguration, LabRunDto, StrategyId, FixtureResetRequest, LabRunProgressEvent } from '@ticketflow/contracts';
import type { AppConfig } from '@ticketflow/config';
import type { Database } from '../../db/pool.js';
import type { Logger } from '../../observability/logger.js';
import { AppError } from '../../shared/errors.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { ExperimentRunner, type AttemptTally } from './runner.js';
import { publishProgress } from './progress-bus.js';
import {
  collectHostInfo,
  finalizeRun,
  getResults,
  getRun,
  insertRun,
  labInvariantViolations,
  labTierId,
  listRuns,
  markRunRunning,
  recordResults,
  resetLabFixture,
  type ExperimentResultRow,
  type ExperimentRunRow,
} from './repository.js';

/**
 * Engineering Lab service (LOCAL/TEST ONLY — ADR-0009).
 *
 * A run is executed synchronously in-process: reset the isolated fixture, fire the concurrent attempts
 * through {@link ExperimentRunner}, persist every per-request result, then write the immutable summary.
 * (BullMQ-backed asynchronous runs are Phase 4; the local runner keeps the flagship experiment a single
 * reproducible command with no queue dependency.)
 */
export class LabService {
  private readonly runner: ExperimentRunner;

  /**
   * Serialized background chain for asynchronous (`mode=live`) runs. The isolated `lab` schema holds ONE
   * fixture, so two concurrent runs would clobber each other's `lab.inventory` if their resets and fan-outs
   * interleaved. Chaining every async run onto this single promise guarantees reset → run → finalize happens
   * one at a time. (The synchronous `createRun` path is used by tests/e2e and remains the caller's own
   * request; the local lab is a single-operator dashboard, so sync-vs-live overlap is out of scope.)
   */
  private backgroundQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.runner = new ExperimentRunner(db, config, logger);
  }

  async createRun(user: AuthenticatedUser, strategy: StrategyId, configuration: LabRunConfiguration, label: string | null): Promise<LabRunDto> {
    // The public reservation path already refuses `unsafe_lab`; defend the lab runner too so the two
    // entry points can never disagree about whether the unsafe baseline may touch public inventory.
    if (strategy === 'unsafe_lab' && !(this.config.LAB_ENABLED && this.config.NODE_ENV !== 'production')) {
      throw new AppError('lab_disabled', 'The unsafe baseline requires the lab to be enabled');
    }

    const tierCount = 1;
    await resetLabFixture(this.db, configuration.seed, configuration.capacity, tierCount);
    const tierId = await labTierId(this.db, configuration.seed, 1);

    const hostInfo = await collectHostInfo(this.db);
    const runId = await insertRun(this.db, {
      strategy,
      configuration,
      label,
      environment: this.config.NODE_ENV,
      gitSha: this.config.GIT_SHA ?? null,
      hostInfo,
      createdBy: user.id,
    });

    await markRunRunning(this.db, runId);
    try {
      const outcome = await this.runner.run(strategy, configuration, tierId);
      await recordResults(
        this.db,
        runId,
        outcome.attempts.map((a) => ({
          requestIndex: a.requestIndex,
          actorLabel: a.actorLabel,
          outcome: a.outcome,
          httpStatus: a.httpStatus,
          latencyMicros: a.latencyMicros,
          failureClass: a.failureClass,
          correlationId: a.correlationId,
        })),
      );
      // The final, terminal write: after this the immutability trigger rejects any further change.
      await finalizeRun(this.db, runId, { status: 'COMPLETED', outcomes: outcome.summary });
    } catch (error) {
      // A run that could not complete still gets a terminal record (with no flattering summary), so the
      // history never shows a half-run as success.
      await finalizeRun(this.db, runId, { status: 'FAILED', outcomes: null }).catch(() => undefined);
      throw error;
    }

    const row = await getRun(this.db, runId);
    if (row === undefined) throw new AppError('internal_error', 'Run vanished immediately after completion');
    return toLabRunDto(row);
  }

  /**
   * Opens an ASYNCHRONOUS run (`?mode=live`): creates the PENDING record and returns immediately so the
   * caller can open the SSE progress stream, then executes the fan-out on the serialized background chain.
   * The fixture reset is deliberately deferred into the queued execution (NOT done here) precisely so a
   * second `openRun` cannot reset the single `lab` fixture while a first run is still mid-flight.
   */
  async openRun(user: AuthenticatedUser, strategy: StrategyId, configuration: LabRunConfiguration, label: string | null): Promise<LabRunDto> {
    if (strategy === 'unsafe_lab' && !(this.config.LAB_ENABLED && this.config.NODE_ENV !== 'production')) {
      throw new AppError('lab_disabled', 'The unsafe baseline requires the lab to be enabled');
    }
    const hostInfo = await collectHostInfo(this.db);
    const runId = await insertRun(this.db, {
      strategy,
      configuration,
      label,
      environment: this.config.NODE_ENV,
      gitSha: this.config.GIT_SHA ?? null,
      hostInfo,
      createdBy: user.id,
    });

    // Enqueue the whole execution (reset → running → fan-out → finalize) behind any prior async run.
    this.backgroundQueue = this.backgroundQueue
      .then(() => this.executeAsync(runId, strategy, configuration))
      .catch(() => undefined); // never let one run's failure poison the chain for later runs

    const row = await getRun(this.db, runId);
    if (row === undefined) throw new AppError('internal_error', 'Run vanished immediately after creation');
    return toLabRunDto(row);
  }

  /** The deferred half of {@link openRun}: runs entirely on the background chain, publishing progress. */
  private async executeAsync(runId: string, strategy: StrategyId, configuration: LabRunConfiguration): Promise<void> {
    const now = (): string => new Date().toISOString();
    try {
      const tierCount = 1;
      await resetLabFixture(this.db, configuration.seed, configuration.capacity, tierCount);
      const tierId = await labTierId(this.db, configuration.seed, 1);
      await markRunRunning(this.db, runId);
      publishProgress(runId, { type: 'phase', phase: 'running', runId, status: 'RUNNING', at: now() });

      const outcome = await this.runner.run(strategy, configuration, tierId, (tally: AttemptTally) => {
        const event: LabRunProgressEvent = { type: 'tick', phase: 'running', runId, ...tally, at: now() };
        publishProgress(runId, event);
      });

      await recordResults(
        this.db,
        runId,
        outcome.attempts.map((a) => ({
          requestIndex: a.requestIndex,
          actorLabel: a.actorLabel,
          outcome: a.outcome,
          httpStatus: a.httpStatus,
          latencyMicros: a.latencyMicros,
          failureClass: a.failureClass,
          correlationId: a.correlationId,
        })),
      );
      await finalizeRun(this.db, runId, { status: 'COMPLETED', outcomes: outcome.summary });
      publishProgress(runId, { type: 'summary', phase: 'completed', runId, status: 'COMPLETED', outcomes: outcome.summary, at: now() });
    } catch (error) {
      // Same honesty rule as the synchronous path: a run that could not finish gets a terminal FAILED record
      // (no flattering summary) and the failure is streamed, never swallowed silently into a stuck UI.
      await finalizeRun(this.db, runId, { status: 'FAILED', outcomes: null }).catch(() => undefined);
      publishProgress(runId, { type: 'phase', phase: 'failed', runId, status: 'FAILED', at: now() });
      this.logger.warn({ runId, strategy, err: error }, 'async lab run failed during background execution');
    }
  }

  async listRuns(page: number, pageSize: number): Promise<{ rows: LabRunDto[]; total: number }> {
    const { rows, total } = await listRuns(this.db, pageSize, (page - 1) * pageSize);
    return { rows: rows.map(toLabRunDto), total };
  }

  async getRunById(id: string): Promise<LabRunDto> {
    const row = await getRun(this.db, id);
    if (row === undefined) throw new AppError('not_found', `Experiment run ${id} does not exist`);
    return toLabRunDto(row);
  }

  async getRunResults(id: string, limit: number): Promise<ExperimentResultView[]> {
    const run = await getRun(this.db, id);
    if (run === undefined) throw new AppError('not_found', `Experiment run ${id} does not exist`);
    const rows = await getResults(this.db, id, limit);
    return rows.map(toExperimentResultView);
  }

  async resetFixture(request: FixtureResetRequest): Promise<{ capacity: number; tiers: number; invariantViolations: number }> {
    await resetLabFixture(this.db, 42, request.capacity, request.tiers);
    return { capacity: request.capacity, tiers: request.tiers, invariantViolations: await labInvariantViolations(this.db) };
  }
}

function toLabRunDto(row: ExperimentRunRow): LabRunDto {
  return {
    id: row.id,
    strategy: row.strategy,
    status: row.status as LabRunDto['status'],
    configuration: row.configuration,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
    gitSha: row.git_sha,
    environment: row.environment,
    outcomes: (row.outcomes ?? null) as LabRunDto['outcomes'],
    reportPaths: Array.isArray(row.report_paths) ? (row.report_paths as string[]) : [],
  };
}

/**
 * JSON-safe view of an experiment result. The contract types these fields as `bigint` (accurate for
 * PostgreSQL INT8 and for in-process TS callers), but JSON has no bigint literal, so the wire form
 * serializes them as decimal strings. Sending a raw `bigint` would make `res.json` throw.
 */
export type ExperimentResultView = {
  id: string;
  runId: string;
  requestIndex: number;
  actorLabel: string;
  outcome: string;
  httpStatus: number | null;
  latencyMicros: string;
  failureClass: string;
  correlationId: string;
  createdAt: string;
};

function toExperimentResultView(row: ExperimentResultRow): ExperimentResultView {
  return {
    id: String(row.id),
    runId: row.run_id,
    requestIndex: row.request_index,
    actorLabel: row.actor_label,
    outcome: row.outcome,
    httpStatus: row.http_status,
    latencyMicros: String(row.latency_micros),
    failureClass: row.failure_class,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}
