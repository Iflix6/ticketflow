import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment loading and validation.
 *
 * Design notes:
 * - Validation happens once, at process start. Nothing in the application reads `process.env`
 *   directly afterwards; everything receives a frozen, typed {@link AppConfig}.
 * - Booleans are parsed from explicit strings. `z.coerce.boolean()` would turn `"false"` into `true`
 *   (it uses `Boolean("false")`), which is a classic misconfiguration footgun.
 * - Production refuses values that look like the committed local defaults (see refine below).
 */

const BOOL_TRUE_VALUES = ['true', '1', 'yes'];

/**
 * Booleans are parsed from explicit strings. `z.coerce.boolean()` would turn `"false"` into `true`
 * (it uses `Boolean("false")`), which is a classic misconfiguration footgun.
 * The default is applied to the *string* enum (before the transform), because zod v4 types
 * `.default()` on a pipe against the output type — and a boolean default would not be re-parsed.
 */
const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => BOOL_TRUE_VALUES.includes(value));

const positiveInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const byteSize = z
  .string()
  .regex(/^\d{1,8}(b|kb|mb)$/i, 'expected forms: 100kb, 1mb, 512b')
  .transform((value) => value.toLowerCase());

/** Local-only defaults that must never survive into a production start. */
const LOCAL_ONLY_SECRET_VALUES = ['ticketflow_local_only', 'changeme', 'change-me', 'secret'];

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['local', 'test', 'ci', 'production']).default('local'),
    HOST: z.string().min(1).default('0.0.0.0'),
    // Port 0 is legal: it asks the OS for a free port, which is exactly what ephemeral test servers use.
    PORT: positiveInt(0, 65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().refine((v) => /^postgres(ql)?:\/\//.test(v), {
      message: 'DATABASE_URL must be a postgresql:// connection string',
    }),
    PG_POOL_MAX: positiveInt(1, 200).default(20),
    PG_CONNECTION_TIMEOUT_MS: positiveInt(100, 120_000).default(5000),
    PG_IDLE_TIMEOUT_MS: positiveInt(100, 600_000).default(30_000),
    STATEMENT_TIMEOUT_MS: positiveInt(100, 120_000).default(5000),
    LOCK_TIMEOUT_MS: positiveInt(100, 120_000).default(2000),
    IDLE_IN_TRANSACTION_TIMEOUT_MS: positiveInt(100, 120_000).default(10_000),
    TX_MAX_ATTEMPTS: positiveInt(1, 10).default(3),
    TX_BASE_DELAY_MS: positiveInt(1, 5000).default(20),
    TX_MAX_DELAY_MS: positiveInt(1, 30_000).default(400),

    REDIS_URL: z.string().refine((v) => /^redis(s)?:\/\//.test(v), {
      message: 'REDIS_URL must be a redis:// connection string',
    }),

    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    SESSION_COOKIE_NAME: z.string().min(1).default('tf_session'),
    SESSION_TTL_HOURS: positiveInt(1, 720).default(12),
    SECURE_COOKIES: boolFromEnv(false),

    RESERVATION_TTL_SECONDS: positiveInt(5, 86_400).default(300),
    MAX_QUANTITY_PER_RESERVATION: positiveInt(1, 100).default(10),
    IDEMPOTENCY_TTL_HOURS: positiveInt(1, 720).default(24),

    RATE_LIMIT_WINDOW_MS: positiveInt(1000, 3_600_000).default(60_000),
    RATE_LIMIT_MAX: positiveInt(1, 100_000).default(120),

    OUTBOX_POLL_MS: positiveInt(100, 60_000).default(1000),
    OUTBOX_BATCH_SIZE: positiveInt(1, 1000).default(50),
    SWEEPER_INTERVAL_MS: positiveInt(500, 600_000).default(15_000),
    WORKER_CONCURRENCY: positiveInt(1, 100).default(5),
    JOB_MAX_ATTEMPTS: positiveInt(1, 20).default(5),

    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
    BODY_LIMIT: byteSize.default('100kb'),

    LAB_ENABLED: boolFromEnv(false),
    LAB_ADMIN_EMAIL: z.email().default('lab@local.test'),

    METRICS_ENABLED: boolFromEnv(true),
    OTEL_ENABLED: boolFromEnv(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

    GIT_SHA: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    if (value.LAB_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['LAB_ENABLED'],
        message: 'LAB_ENABLED must be false when NODE_ENV=production (ADR-0009)',
      });
    }
    for (const [key, candidate] of [
      ['AUTH_SECRET', value.AUTH_SECRET],
      ['DATABASE_URL', value.DATABASE_URL],
    ] as const) {
      const looksLocal = LOCAL_ONLY_SECRET_VALUES.some((secret) =>
        candidate.toLowerCase().includes(secret),
      );
      if (looksLocal) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} still contains a committed local-only default value`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
export type AppConfig = Readonly<Env>;

export class ConfigError extends Error {
  constructor(message: string, readonly issues: readonly string[]) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Loads `.env` from the current working directory when present.
 * Node's own `--env-file` remains supported; real environment variables always win because
 * `loadEnvFile` only fills unset keys (implemented by `process.loadEnvFile` semantics).
 */
export function loadDotEnv(cwd: string = process.cwd()): string | undefined {
  const candidate = path.join(cwd, '.env');
  if (!existsSync(candidate)) return undefined;
  process.loadEnvFile(candidate);
  return candidate;
}

export function loadConfig(raw: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    // Issues are part of the message itself: a bare "Invalid environment configuration" makes a
    // crash log useless unless somebody also dumps the `issues` property.
    throw new ConfigError(`Invalid environment configuration: ${issues.join('; ')}`, issues);
  }
  return Object.freeze({ ...parsed.data });
}

/** Convenience for processes: load .env then validate, or fail with a readable report. */
export function bootstrapConfig(logger?: { error: (msg: string) => void }): AppConfig {
  loadDotEnv();
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      const report = [`Invalid environment configuration:`, ...error.issues].join('\n  - ');
      (logger?.error ?? console.error)(report);
      throw error;
    }
    throw error;
  }
}
