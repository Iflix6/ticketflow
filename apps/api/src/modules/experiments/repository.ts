import type { LabRunConfiguration, StrategyId } from '@ticketflow/contracts';
import type { Database, Queryable } from '../../db/pool.js';

/**
 * Experiment-run persistence (LOCAL/TEST ONLY — ADR-0009).
 *
 * This repository owns the SQL for `experiment_runs`, `experiment_results`, and the isolated `lab`
 * schema fixture. It never decides outcomes or classifies failures — that is the runner's job. Keeping
 * the writes here means the run lifecycle (create → running → immutable completion) is expressed in one
 * place and mirrors the DB constraints: the immutability trigger (TF002) fires if anything tries to
 * touch a run once `finished_at` is set, so `finalizeRun` is the LAST write a run ever receives.
 */

export type ExperimentRunRow = {
  id: string;
  strategy: StrategyId;
  configuration: LabRunConfiguration;
  label: string | null;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  git_sha: string | null;
  environment: string;
  host_info: Record<string, unknown> | null;
  outcomes: Record<string, unknown> | null;
  report_paths: unknown;
  created_at: Date;
};

export type ExperimentResultRow = {
  id: bigint;
  run_id: string;
  request_index: number;
  actor_label: string;
  outcome: string;
  http_status: number | null;
  latency_micros: bigint;
  failure_class: string;
  correlation_id: string;
  created_at: Date;
};

export async function insertRun(
  db: Queryable,
  params: {
    strategy: StrategyId;
    configuration: LabRunConfiguration;
    label: string | null;
    environment: string;
    gitSha: string | null;
    hostInfo: Record<string, unknown>;
    createdBy: string | null;
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO experiment_runs (strategy, configuration, label, status, environment, git_sha, host_info, created_by)
     VALUES ($1, $2::jsonb, $3, 'PENDING', $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [
      params.strategy,
      JSON.stringify(params.configuration),
      params.label,
      params.environment,
      params.gitSha,
      JSON.stringify(params.hostInfo),
      params.createdBy,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('experiment run insert returned no row');
  return id;
}

export async function markRunRunning(db: Queryable, runId: string): Promise<void> {
  await db.query(`UPDATE experiment_runs SET status = 'RUNNING' WHERE id = $1`, [runId]);
}

/**
 * Batch-inserts every per-request result with one statement (UNNEST of parallel arrays) so a 5,000-request
 * run does not issue 5,000 round trips. `latency_micros` and `http_status` are passed as arrays whose
 * element types match the columns (bigint / nullable integer).
 */
export async function recordResults(
  db: Queryable,
  runId: string,
  rows: Array<{
    requestIndex: number;
    actorLabel: string;
    outcome: string;
    httpStatus: number | null;
    latencyMicros: number;
    failureClass: string;
    correlationId: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO experiment_results (run_id, request_index, actor_label, outcome, http_status, latency_micros, failure_class, correlation_id)
     SELECT $1, i, a, o, h, l, f, c
       FROM UNNEST(
         $2::int[], $3::text[], $4::text[], $5::int[], $6::bigint[], $7::text[], $8::text[]
       ) AS t(i, a, o, h, l, f, c)`,
    [
      runId,
      rows.map((r) => r.requestIndex),
      rows.map((r) => r.actorLabel),
      rows.map((r) => r.outcome),
      rows.map((r) => r.httpStatus),
      rows.map((r) => Math.round(r.latencyMicros)),
      rows.map((r) => r.failureClass),
      rows.map((r) => r.correlationId),
    ],
  );
}

/**
 * The one and only terminal write: status + summary + finished timestamp. After this, `finished_at` is
 * non-null and the immutability trigger rejects any further UPDATE/DELETE, so a completed run's summary
 * can never be edited into a more flattering shape after the fact.
 */
export async function finalizeRun(
  db: Queryable,
  runId: string,
  params: { status: 'COMPLETED' | 'FAILED' | 'ABORTED'; outcomes: Record<string, unknown> | null },
): Promise<void> {
  await db.query(
    `UPDATE experiment_runs
        SET status = $2, outcomes = $3::jsonb, finished_at = app.now()
      WHERE id = $1`,
    [runId, params.status, params.outcomes === null ? null : JSON.stringify(params.outcomes)],
  );
}

export async function listRuns(db: Queryable, limit: number, offset: number): Promise<{ rows: ExperimentRunRow[]; total: number }> {
  const rowsResult = await db.query<ExperimentRunRow>(
    `SELECT id, strategy, configuration, label, status, started_at, finished_at, git_sha, environment,
            host_info, outcomes, report_paths, created_at
       FROM experiment_runs
      ORDER BY started_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const countResult = await db.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM experiment_runs');
  return { rows: rowsResult.rows, total: Number(countResult.rows[0]?.total ?? '0') };
}

export async function getRun(db: Queryable, runId: string): Promise<ExperimentRunRow | undefined> {
  const result = await db.query<ExperimentRunRow>(
    `SELECT id, strategy, configuration, label, status, started_at, finished_at, git_sha, environment,
            host_info, outcomes, report_paths, created_at
       FROM experiment_runs WHERE id = $1`,
    [runId],
  );
  return result.rows[0];
}

/** Bounded per-request result page for the failure explorer / request timeline. */
export async function getResults(db: Queryable, runId: string, limit: number): Promise<ExperimentResultRow[]> {
  const result = await db.query<ExperimentResultRow>(
    `SELECT id, run_id, request_index, actor_label, outcome, http_status, latency_micros, failure_class,
            correlation_id, created_at
       FROM experiment_results
      WHERE run_id = $1
      ORDER BY request_index
      LIMIT $2`,
    [runId, limit],
  );
  return result.rows;
}

// --------------------------------------------------------------- lab fixture ----

/** Deterministic tier id for a (seed, index) — the same helper the migration defines, so the runner and
 *  the reset function agree on which rows exist without generating randomness in TypeScript. */
export async function labTierId(db: Queryable, seed: number, index: number): Promise<string> {
  const result = await db.query<{ tier_id: string }>('SELECT lab.tier_id($1::int, $2::int) AS tier_id', [seed, index]);
  const id = result.rows[0]?.tier_id;
  if (id === undefined) throw new Error('lab.tier_id returned no row');
  return id;
}

/**
 * Resets the isolated lab fixture to a known state. Delegates entirely to `lab.reset_fixture` (a single
 * SQL function) so the endpoint and the tests cannot diverge or leave a half-reset behind.
 */
export async function resetLabFixture(db: Database, seed: number, capacity: number, tierCount: number): Promise<void> {
  await db.query('SELECT lab.reset_fixture($1::int, $2::int, $3::int)', [seed, capacity, tierCount]);
}

/** Over-allocation detector for the lab fixture, judged by the same standard as the safe path (view L3). */
export async function labInvariantViolations(db: Queryable): Promise<number> {
  const result = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM lab.live_allocation_violations');
  return Number(result.rows[0]?.n ?? '0');
}

/** A compact machine description captured once per run so a report is interpretable without asking. */
export async function collectHostInfo(db: Database): Promise<Record<string, unknown>> {
  const version = await db.query<{ v: string }>('SELECT current_setting($1) AS v', ['server_version']);
  const os = await import('node:os');
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    postgresVersion: version.rows[0]?.v ?? 'unknown',
    pool: db.stats(),
  };
}
