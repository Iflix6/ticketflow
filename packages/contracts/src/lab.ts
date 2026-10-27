import { z } from 'zod';

/**
 * Engineering Lab contracts.
 *
 * Everything here is local/test only (ADR-0009): the routes are not mounted unless
 * `LAB_ENABLED=true` and `NODE_ENV` is `local`, `test`, or `ci`.
 */

export const STRATEGY_IDS = [
  'atomic_update',
  'pessimistic',
  'optimistic',
  'unsafe_lab',
] as const;

export const strategyIdSchema = z.enum(STRATEGY_IDS);
export type StrategyId = z.infer<typeof strategyIdSchema>;

export const SAFE_STRATEGY_IDS = ['atomic_update', 'pessimistic', 'optimistic'] as const;
export const LAB_ONLY_STRATEGY_IDS = ['unsafe_lab'] as const;

export const strategyDescriptorSchema = z.object({
  id: strategyIdSchema,
  label: z.string(),
  summary: z.string(),
  /** The exact SQL used for allocation, surfaced in the UI so claims stay inspectable. */
  sql: z.string(),
  safe: z.boolean(),
  labOnly: z.boolean(),
  tradeoffs: z.array(z.string()),
});
export type StrategyDescriptorDto = z.infer<typeof strategyDescriptorSchema>;

export const labRunConfigurationSchema = z
  .object({
    capacity: z.int().min(1).max(100_000),
    concurrentUsers: z.int().min(1).max(5000),
    quantityPerUser: z.int().min(1).max(100).default(1),
    /** 0 = barrier start (all requests fire together); >0 = linear ramp window in ms. */
    rampMs: z.int().min(0).max(600_000).default(0),
    /** Artificial delay inside the unsafe read-modify-write window (ms). */
    artificialDelayMs: z.int().min(0).max(5000).default(0),
    reservationTtlSeconds: z.int().min(5).max(86_400).default(300),
    /** Deterministic RNG seed so runs are comparable across strategies. */
    seed: z.int().min(0).default(42),
    dbPoolMax: z.int().min(1).max(200).default(20),
    isolation: z.enum(['read_committed', 'repeatable_read', 'serializable']).default('read_committed'),
  })
  .strict();
export type LabRunConfiguration = z.infer<typeof labRunConfigurationSchema>;

export const createLabRunRequestSchema = z
  .object({
    strategy: strategyIdSchema,
    configuration: labRunConfigurationSchema,
    label: z.string().min(1).max(120).optional(),
  })
  .strict();
export type CreateLabRunRequest = z.infer<typeof createLabRunRequestSchema>;

export const labRunStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED']);

export const experimentOutcomeSchema = z.enum([
  'SUCCEEDED',
  'SOLD_OUT',
  'CONFLICT',
  'DUPLICATE',
  'VALIDATION_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
]);
export type ExperimentOutcome = z.infer<typeof experimentOutcomeSchema>;

export const failureClassificationSchema = z.enum([
  'none',
  'lost_update_overallocation',
  'invariant_violation_failed_insert',
  'negative_available',
  'duplicate_booking',
  'idempotency_violation',
  'deadlock',
  'timeout',
  'unknown',
]);
export type FailureClassification = z.infer<typeof failureClassificationSchema>;

export const labRunSchema = z.object({
  id: z.uuid(),
  strategy: strategyIdSchema,
  status: labRunStatusSchema,
  configuration: labRunConfigurationSchema,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  gitSha: z.string().nullable(),
  environment: z.string(),
  outcomes: z
    .object({
      attempted: z.int().min(0),
      succeeded: z.int().min(0),
      soldOut: z.int().min(0),
      conflict: z.int().min(0),
      duplicate: z.int().min(0),
      validationError: z.int().min(0),
      serverError: z.int().min(0),
      timeout: z.int().min(0),
      throughputPerSecond: z.number().nullable(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
      p99Ms: z.number().nullable(),
      durationMs: z.int().min(0).nullable(),
      invariantViolations: z.int().min(0),
    })
    .nullable(),
  reportPaths: z.array(z.string()).default([]),
});
export type LabRunDto = z.infer<typeof labRunSchema>;

export const experimentResultSchema = z.object({
  id: z.bigint(),
  runId: z.uuid(),
  requestIndex: z.int().min(0),
  actorLabel: z.string(),
  outcome: experimentOutcomeSchema,
  httpStatus: z.int().nullable(),
  latencyMicros: z.bigint().min(0n),
  failureClass: failureClassificationSchema,
  correlationId: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ExperimentResultDto = z.infer<typeof experimentResultSchema>;

export const invariantViolationSchema = z.object({
  tierId: z.uuid().nullable(),
  invariant: z.string(),
  observed: z.record(z.string(), z.json()),
});

export const fixtureResetRequestSchema = z
  .object({
    capacity: z.int().min(1).max(100_000).default(100),
    tiers: z.int().min(1).max(10).default(1),
  })
  .strict();
export type FixtureResetRequest = z.infer<typeof fixtureResetRequestSchema>;
