import { ERROR_STATUS_MAP, type ErrorCode, type HttpStatusCode } from '@ticketflow/contracts';

/**
 * Application error model.
 *
 * Every failure that can reach a client is an {@link AppError} carrying a closed-set `code`. The HTTP
 * status is derived from the code (never chosen ad hoc in a handler), so the OpenAPI document, the
 * tests, and the UI all agree on the taxonomy.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Non-sensitive, non-PII context only. */
    readonly details?: Record<string, unknown>,
    /** `override` is required because `Error` declares `cause` (ES2022 lib) and we narrow it. */
    override readonly cause?: unknown,
    /** Override only for codes that legitimately map to several statuses (e.g. 425 Too Early). */
    readonly statusOverride?: HttpStatusCode,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): HttpStatusCode {
    return this.statusOverride ?? ERROR_STATUS_MAP[this.code];
  }

  static of(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, message, details);
  }
}

/** PostgreSQL SQLSTATE codes this application reasons about explicitly. */
export const PG_SQLSTATE = {
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  CHECK_VIOLATION: '23514',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  QUERY_CANCELED: '57014',
  ADMIN_SHUTDOWN: '57P01',
  CANNOT_CONNECT_NOW: '57P03',
  CONNECTION_EXCEPTION: '08006',
  CONNECTION_FAILURE: '08001',
  TOO_MANY_CONNECTIONS: '53300',
  INVALID_TEXT_REPRESENTATION: '22P02',
  FEATURE_NOT_SUPPORTED: '0A000',
  /** Raised by app.reservations_enforce_transition() (see migration 0005). */
  ILLEGAL_RESERVATION_TRANSITION: 'TF001',
  /** Raised by app.experiment_runs_enforce_immutability() (see migration 0007). */
  IMMUTABLE_RUN_SUMMARY: 'TF002',
} as const;

export interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

export function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * Only these codes are retried, and only when the transaction has not produced an effect that a retry
 * would duplicate (ADR-0003). Everything else propagates.
 */
const TRANSIENT_RETRYABLE = new Set<string>([
  PG_SQLSTATE.SERIALIZATION_FAILURE,
  PG_SQLSTATE.DEADLOCK_DETECTED,
  PG_SQLSTATE.LOCK_NOT_AVAILABLE,
]);

export function isTransientRetryableCode(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT_RETRYABLE.has(code);
}

/** Dependency outages are a distinct class: fail readiness, return 503, do not mask as 500. */
const DEPENDENCY_CODES = new Set<string>([
  PG_SQLSTATE.TOO_MANY_CONNECTIONS,
  PG_SQLSTATE.CANNOT_CONNECT_NOW,
  PG_SQLSTATE.CONNECTION_EXCEPTION,
  PG_SQLSTATE.CONNECTION_FAILURE,
  PG_SQLSTATE.ADMIN_SHUTDOWN,
]);

export function isDependencyFailureCode(code: string | undefined): boolean {
  return code !== undefined && DEPENDENCY_CODES.has(code);
}

/** Maps a low-level error onto the client-visible taxonomy, preserving detail for logs. */
export function toAppError(error: unknown, fallbackMessage = 'Internal server error'): AppError {
  if (error instanceof AppError) return error;

  if (isPgError(error)) {
    const code = error.code ?? '';
    if (isDependencyFailureCode(code)) {
      return new AppError('dependency_unavailable', 'Database is currently unavailable', {
        sqlstate: code,
      }, error);
    }
    if (code === PG_SQLSTATE.QUERY_CANCELED) {
      return new AppError('conflict', 'Query timed out under load', { sqlstate: code }, error);
    }
    if (code === PG_SQLSTATE.ILLEGAL_RESERVATION_TRANSITION) {
      return new AppError('invalid_transition', 'Reservation state transition is not allowed', {
        sqlstate: code,
      }, error);
    }
    if (code === PG_SQLSTATE.IMMUTABLE_RUN_SUMMARY) {
      return new AppError('conflict', 'Completed experiment runs are immutable', {
        sqlstate: code,
      }, error);
    }
    // Anything else from PostgreSQL is our bug, not the client's. Never leak the driver message body.
    return new AppError('internal_error', fallbackMessage, { sqlstate: code }, error);
  }

  return new AppError('internal_error', fallbackMessage, undefined, error);
}

/** Error message with cause chain, for logging only (never returned to a client verbatim). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error instanceof AppError && error.cause ? ` causedBy ${describeError(error.cause)}` : '';
    // `isPgError` is a guard over `unknown`: inside this `Error` branch the intersection would
    // narrow to `never`, so the code is read through an explicit cast instead.
    const pgCode = isPgError(error) ? ` sqlstate=${(error as unknown as PgErrorLike).code}` : '';
    return `${error.name}: ${error.message}${pgCode}${cause}`;
  }
  return String(error);
}
