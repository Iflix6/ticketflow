import type {
  BookingDto,
  CheckoutRequest,
  CreateReservationRequest,
  ErrorCode,
  ReservationDto,
} from '@ticketflow/contracts';
import { SAFE_STRATEGY_IDS } from '@ticketflow/contracts';
import { trace } from '@opentelemetry/api';
import type { AppConfig } from '@ticketflow/config';
import type { Database, Queryable } from '../../db/pool.js';
import { asQueryable } from '../../db/pool.js';
import { ISOLATION_LEVELS, retryPolicyFrom, runWithTransientRetry, timeoutsFrom, withTransaction } from '../../db/transaction.js';
import type { Logger } from '../../observability/logger.js';
import { domainTracer } from '../../observability/tracing.js';
import { appMetrics } from '../../observability/metrics.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { AppError } from '../../shared/errors.js';
import { errorBody } from '../../shared/respond.js';
import { hashRequestPayload } from '../../shared/crypto.js';
import { multiplyMoneyByInt } from '../../shared/money.js';
import { toBookingDto, toReservationDto } from '../../shared/serialize.js';
import { acquireIdempotency, completeIdempotency, type IdempotencyAcquisition } from '../idempotency/repository.js';
import { insertOutboxEvent, recordAudit } from '../outbox/repository.js';
import { charge as fakeCharge, type ChargeResult } from '../payments/fake-provider.js';
import { recordReconciliationFinding } from '../bookings/reconciliation.js';
import { findBookingByReservation, insertBooking, insertPaymentAttempt } from '../bookings/repository.js';
import {
  allocateOptimistic,
  allocatePessimistic,
  cancelReservation as cancelReservationRow,
  commitReservedToSold,
  confirmReservation as confirmReservationRow,
  expireReservation as expireReservationRow,
  failReservation,
  findReservation,
  findReservationForUpdate,
  findTierForUpdate,
  insertReservation,
  listReservationsForUser,
  releaseReserved,
  tryAllocate,
  type AllocationResult,
  type ReservationRow,
} from './repository.js';

/**
 * Reservation + checkout orchestration (Safe strategy A).
 *
 * Every mutation is ONE PostgreSQL transaction that bundles, atomically: the idempotency-key
 * acquisition, the inventory counter change, the reservation/booking row, the outbox event and the
 * audit record. That bundling is the whole correctness story — there is no interleaving where the
 * money moved but inventory did not, or the row committed but its event was lost, because they share
 * one commit. Failures that must NOT be recorded (sold out, wrong owner, invalid transition against a
 * concurrently-moved row) are thrown so the transaction rolls back and the idempotency key is freed
 * for a genuine retry; failures that ARE a stable business outcome (a payment arriving after the
 * hold expired) are handled by writing the reconciliation row and returning a committed 409.
 */

export interface ServiceResult<TData> {
  status: number;
  body: { data: TData } | { error: ReturnType<typeof errorBody> };
  replay: boolean;
}

const ENDPOINT_CREATE = 'POST /api/v1/reservations';
const cancelEndpoint = (id: string): string => `POST /api/v1/reservations/${id}/cancel`;
const checkoutEndpoint = (id: string): string => `POST /api/v1/reservations/${id}/checkout`;

/**
 * Strategies the customer (public-inventory) path accepts. The unsafe baseline is deliberately absent:
 * it must never run against live inventory (ADR-0009); it exists only inside the isolated lab fixture.
 */
const PUBLIC_STRATEGIES = new Set<string>(SAFE_STRATEGY_IDS);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ReservationsService {
  // No-op tracer until `startTracing` registers a provider, so these spans cost nothing when disabled.
  private readonly tracer = domainTracer();

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private runTx<T>(label: string, work: (client: Queryable) => Promise<T>): Promise<T> {
    // One span per business transaction (create/cancel/checkout), labelled by the bounded `label` — never
    // by a reservation id — so the trace view groups the linearization points without unbounded cardinality.
    return this.tracer.startActiveSpan(`db.tx.${label}`, async (span) => {
      span.setAttribute('db.tx.label', label);
      try {
        const policy = { ...retryPolicyFrom(this.config), label };
        return await runWithTransientRetry(policy, () =>
          withTransaction(
            this.db,
            { label, isolation: ISOLATION_LEVELS.readCommitted, timeouts: timeoutsFrom(this.config) },
            (sqlClient) => work(asQueryable(sqlClient)),
          ),
        );
      } catch (error) {
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------- create ----
  async createReservation(
    user: AuthenticatedUser,
    request: CreateReservationRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<ServiceResult<ReservationDto>> {
    // Bounded, DB-free pre-checks: fail before opening a transaction so a rejected request never
    // touches inventory.
    if (request.quantity > this.config.MAX_QUANTITY_PER_RESERVATION) {
      throw new AppError(
        'validation_failed',
        `Quantity exceeds the maximum of ${this.config.MAX_QUANTITY_PER_RESERVATION} per reservation`,
        { maxQuantity: this.config.MAX_QUANTITY_PER_RESERVATION },
      );
    }
    const strategy = request.strategy ?? 'atomic_update';
    // Phase 3: Safe A/B/C are available to customers. Any other id (including `unsafe_lab`) is refused
    // before a transaction opens, so the unsafe baseline can never touch public inventory.
    if (!PUBLIC_STRATEGIES.has(strategy)) {
      throw new AppError(
        'strategy_unavailable',
        `Strategy ${strategy} is not available on public inventory`,
        { strategy, allowed: [...PUBLIC_STRATEGIES] },
      );
    }
    const ttlSeconds = request.reservationTtlSeconds ?? this.config.RESERVATION_TTL_SECONDS;
    const requestHash = hashRequestPayload({
      tierId: request.tierId,
      quantity: request.quantity,
      reservationTtlSeconds: request.reservationTtlSeconds ?? null,
      strategy,
    });

    return this.runTx('reserve.atomic_update', async (client) => {
      // Attributes the linearization point for this trace (a span may carry high-cardinality ids; a
      // metric label may not — that rule lives in metrics.ts, not here).
      trace.getActiveSpan()?.setAttribute('reservation.strategy', strategy);
      trace.getActiveSpan()?.setAttribute('reservation.tier_id', request.tierId);
      const acquisition = await acquireIdempotency(client, {
        scopeUserId: user.id,
        scopeEndpoint: ENDPOINT_CREATE,
        key: idempotencyKey,
        requestHash,
        ttlHours: this.config.IDEMPOTENCY_TTL_HOURS,
      });
      const started = this.handleAcquisition(acquisition);
      if (started.kind === 'replay') return started.result;
      const recordId = started.recordId;

      const tier = await findTierForUpdate(client, request.tierId);
      if (tier === undefined) throw new AppError('not_found', `Ticket tier ${request.tierId} does not exist`);
      if (tier.event_status !== 'ON_SALE') {
        throw new AppError('conflict', `Event is not on sale (status ${tier.event_status})`, {
          eventStatus: tier.event_status,
        });
      }

      const allocation = await this.allocate(client, strategy, request.tierId, request.quantity);
      if (allocation.kind === 'sold_out') {
        // Sold out is not a committed outcome: throw so the transaction (and the IN_PROGRESS key row)
        // rolls back and a later retry — after an expiry frees seats — can still succeed.
        appMetrics.reservationOutcomes.inc({ strategy, outcome: 'sold_out' });
        throw new AppError('sold_out', 'No tickets are available for that tier');
      }
      if (allocation.kind === 'conflict') {
        // Optimistic retry budget exhausted while seats remained: a transient contention signal, not a
        // business rejection. Roll back (freeing the key) so the client may retry immediately.
        appMetrics.reservationOutcomes.inc({ strategy, outcome: 'conflict' });
        throw new AppError('conflict', 'Inventory changed concurrently; retry the reservation', {
          attempts: allocation.attempts,
        });
      }
      const counters = allocation.counters;

      const reservation = await insertReservation(client, {
        userId: user.id,
        tierId: request.tierId,
        quantity: request.quantity,
        strategy,
        ttlSeconds,
        idempotencyRecordId: recordId,
      });

      await insertOutboxEvent(client, {
        eventType: 'reservation.created',
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        payload: {
          userId: user.id,
          tierId: request.tierId,
          quantity: request.quantity,
          status: 'PENDING',
          strategy,
          // Post-allocation counters, captured in the same transaction — useful for the event consumer
          // and for reconciling an advisory cache without a second read.
          availableAfter: counters.available,
          reservedAfter: counters.reserved,
        },
      });
      await recordAudit(client, {
        actorUserId: user.id,
        actorKind: 'user',
        action: 'reservation.create',
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        metadata: { tierId: request.tierId, quantity: request.quantity, strategy },
        requestId,
      });

      const body = { data: toReservationDto(reservation, reservation.seconds_remaining) };
      await completeIdempotency(client, {
        recordId,
        responseStatus: 201,
        responseBody: body,
        resourceType: 'reservation',
        resourceId: reservation.id,
      });
      appMetrics.reservationOutcomes.inc({ strategy, outcome: 'created' });
      this.logger.debug({ reservationId: reservation.id }, 'reservation created');
      return { status: 201, body, replay: false } satisfies ServiceResult<ReservationDto>;
    });
  }

  // ---------------------------------------------------------------- cancel ----
  async cancelReservation(
    user: AuthenticatedUser,
    reservationId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<ServiceResult<ReservationDto>> {
    const requestHash = hashRequestPayload({ action: 'cancel', reservationId });
    return this.runTx('reservation.cancel', async (client) => {
      const acquisition = await acquireIdempotency(client, {
        scopeUserId: user.id,
        scopeEndpoint: cancelEndpoint(reservationId),
        key: idempotencyKey,
        requestHash,
        ttlHours: this.config.IDEMPOTENCY_TTL_HOURS,
      });
      const started = this.handleAcquisition(acquisition);
      if (started.kind === 'replay') return started.result;
      const recordId = started.recordId;

      const locked = await findReservationForUpdate(client, reservationId);
      if (locked === undefined) throw new AppError('not_found', `Reservation ${reservationId} does not exist`);
      this.assertOwner(user, locked);

      // Already canceled: a no-op success (idempotent by resource, not just by key).
      if (locked.status === 'CANCELED') {
        const body = { data: toReservationDto(locked, locked.seconds_remaining) };
        await completeIdempotency(client, {
          recordId,
          responseStatus: 200,
          responseBody: body,
          resourceType: 'reservation',
          resourceId: reservationId,
        });
        return { status: 200, body, replay: false } satisfies ServiceResult<ReservationDto>;
      }
      if (locked.status !== 'PENDING') {
        throw new AppError('invalid_transition', `Cannot cancel a ${locked.status} reservation`, {
          from: locked.status,
          to: 'CANCELED',
        });
      }

      const canceled = await cancelReservationRow(client, reservationId);
      if (canceled === null) throw new AppError('conflict', 'Reservation changed concurrently');
      await releaseReserved(client, canceled.tier_id, canceled.quantity);
      await insertOutboxEvent(client, {
        eventType: 'reservation.canceled',
        aggregateType: 'reservation',
        aggregateId: reservationId,
        payload: { tierId: canceled.tier_id, quantity: canceled.quantity, status: 'CANCELED' },
      });
      await recordAudit(client, {
        actorUserId: user.id,
        actorKind: 'user',
        action: 'reservation.cancel',
        aggregateType: 'reservation',
        aggregateId: reservationId,
        metadata: { tierId: canceled.tier_id, quantity: canceled.quantity },
        requestId,
      });

      const body = { data: toReservationDto(canceled, canceled.seconds_remaining) };
      await completeIdempotency(client, {
        recordId,
        responseStatus: 200,
        responseBody: body,
        resourceType: 'reservation',
        resourceId: reservationId,
      });
      appMetrics.reservationOutcomes.inc({ strategy: canceled.strategy, outcome: 'canceled' });
      return { status: 200, body, replay: false } satisfies ServiceResult<ReservationDto>;
    });
  }

  // -------------------------------------------------------------- checkout ----
  async checkout(
    user: AuthenticatedUser,
    reservationId: string,
    request: CheckoutRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<ServiceResult<BookingDto | ReservationDto>> {
    const requestHash = hashRequestPayload({
      reservationId,
      simulatedOutcome: request.simulatedOutcome,
      delayMs: request.delayMs,
    });
    // Artificial gateway latency, applied BEFORE the transaction opens so a slow "provider" never
    // holds a database transaction (and its row locks) open. The confirm-vs-expire race is still real:
    // the reservation may expire while we wait, and the conditional confirm handles it.
    if (request.delayMs > 0) await sleep(request.delayMs);

    return this.runTx('checkout', async (client) => {
      const acquisition = await acquireIdempotency(client, {
        scopeUserId: user.id,
        scopeEndpoint: checkoutEndpoint(reservationId),
        key: idempotencyKey,
        requestHash,
        ttlHours: this.config.IDEMPOTENCY_TTL_HOURS,
      });
      const started = this.handleAcquisition(acquisition);
      if (started.kind === 'replay') return started.result;
      const recordId = started.recordId;

      const reservation = await findReservationForUpdate(client, reservationId);
      if (reservation === undefined) throw new AppError('not_found', `Reservation ${reservationId} does not exist`);
      this.assertOwner(user, reservation);

      const tier = await findTierForUpdate(client, reservation.tier_id);
      if (tier === undefined) {
        throw new AppError('internal_error', 'Reservation references a missing tier');
      }
      const total = multiplyMoneyByInt(tier.price_display_only, reservation.quantity);
      const result = fakeCharge({ reservationId, outcome: request.simulatedOutcome }, total);

      // Already confirmed: replay the existing booking (idempotent by resource), whatever this key is.
      if (reservation.status === 'CONFIRMED') {
        const booking = await findBookingByReservation(client, reservationId);
        if (booking === undefined) {
          throw new AppError('internal_error', 'Confirmed reservation has no booking');
        }
        const body = { data: toBookingDto(booking) };
        await completeIdempotency(client, {
          recordId,
          responseStatus: 200,
          responseBody: body,
          resourceType: 'booking',
          resourceId: booking.id,
        });
        return { status: 200, body, replay: false } satisfies ServiceResult<BookingDto>;
      }

      // Any other terminal status cannot be fulfilled.
      if (reservation.status !== 'PENDING') {
        return this.refuseNotConfirmable(client, recordId, reservation, result, requestId);
      }

      if (result.status === 'SUCCEEDED') {
        const confirmed = await confirmReservationRow(client, reservationId);
        if (confirmed === null) {
          // The deadline passed (the reservation was PENDING but expiring): expire + release now so the
          // invariant holds immediately, then reconcile the successful payment instead of resurrecting
          // inventory. Same-transaction clock (`app.now()` is the stable transaction timestamp) makes
          // this branch and `expireReservation` mutually consistent.
          const expired = await expireReservationRow(client, reservationId);
          if (expired !== null) await releaseReserved(client, expired.tier_id, expired.quantity);
          return this.recordPaymentAfterExpiry(client, recordId, reservation, result, requestId);
        }

        const booking = await insertBooking(client, {
          reservationId,
          status: 'CONFIRMED',
          totalAmount: total,
          currency: tier.currency,
          confirmNow: true,
        });
        await insertPaymentAttempt(client, {
          bookingId: booking.id,
          providerReference: result.providerReference,
          status: 'SUCCEEDED',
          amount: total,
          simulatedOutcome: request.simulatedOutcome,
          completedAtNow: true,
        });
        await commitReservedToSold(client, reservation.tier_id, reservation.quantity);
        await insertOutboxEvent(client, {
          eventType: 'reservation.confirmed',
          aggregateType: 'reservation',
          aggregateId: reservationId,
          payload: { bookingId: booking.id, quantity: reservation.quantity, outcome: 'success' },
        });
        await insertOutboxEvent(client, {
          eventType: 'booking.confirmed',
          aggregateType: 'booking',
          aggregateId: booking.id,
          payload: { reservationId, totalAmount: total, currency: tier.currency },
        });
        await recordAudit(client, {
          actorUserId: user.id,
          actorKind: 'user',
          action: 'checkout.succeeded',
          aggregateType: 'booking',
          aggregateId: booking.id,
          metadata: { reservationId, outcome: 'success', providerReference: result.providerReference },
          requestId,
        });
        const body = { data: toBookingDto(booking) };
        await completeIdempotency(client, {
          recordId,
          responseStatus: 201,
          responseBody: body,
          resourceType: 'booking',
          resourceId: booking.id,
        });
        appMetrics.reservationOutcomes.inc({ strategy: reservation.strategy, outcome: 'confirmed' });
        return { status: 201, body, replay: false } satisfies ServiceResult<BookingDto>;
      }

      if (result.status === 'FAILED') {
        // Declined: fail the hold, return its seats, and record the decline as a FAILED booking + attempt.
        const failed = await failReservation(client, reservationId, 'payment_declined');
        if (failed === null) throw new AppError('conflict', 'Reservation changed concurrently');
        await releaseReserved(client, failed.tier_id, failed.quantity);
        const booking = await insertBooking(client, {
          reservationId,
          status: 'FAILED',
          totalAmount: total,
          currency: tier.currency,
        });
        await insertPaymentAttempt(client, {
          bookingId: booking.id,
          providerReference: result.providerReference,
          status: 'FAILED',
          amount: total,
          simulatedOutcome: request.simulatedOutcome,
          completedAtNow: true,
        });
        await insertOutboxEvent(client, {
          eventType: 'reservation.failed',
          aggregateType: 'reservation',
          aggregateId: reservationId,
          payload: { bookingId: booking.id, reason: 'payment_declined', outcome: 'failure' },
        });
        await recordAudit(client, {
          actorUserId: user.id,
          actorKind: 'user',
          action: 'checkout.declined',
          aggregateType: 'booking',
          aggregateId: booking.id,
          metadata: { reservationId, outcome: 'failure' },
          requestId,
        });
        const body = { data: toBookingDto(booking) };
        await completeIdempotency(client, {
          recordId,
          responseStatus: 200,
          responseBody: body,
          resourceType: 'booking',
          resourceId: booking.id,
        });
        appMetrics.reservationOutcomes.inc({ strategy: reservation.strategy, outcome: 'declined' });
        return { status: 200, body, replay: false } satisfies ServiceResult<BookingDto>;
      }

      // TIMEOUT: outcome unknown. Do NOT confirm and do NOT release — keep the PENDING hold and return
      // 202 Accepted with the still-pending reservation. The sweeper may expire it; reconciliation of a
      // late success is the documented follow-up (Phase 4). This is the honest boundary: we never mark
      // money as settled on an ambiguous provider signal.
      await recordAudit(client, {
        actorUserId: user.id,
        actorKind: 'user',
        action: 'checkout.timeout',
        aggregateType: 'reservation',
        aggregateId: reservationId,
        metadata: { outcome: 'timeout', providerReference: result.providerReference },
        requestId,
      });
      const pendingBody = { data: toReservationDto(reservation, reservation.seconds_remaining) };
      await completeIdempotency(client, {
        recordId,
        responseStatus: 202,
        responseBody: pendingBody,
        resourceType: 'reservation',
        resourceId: reservationId,
      });
      appMetrics.reservationOutcomes.inc({ strategy: reservation.strategy, outcome: 'timeout' });
      return { status: 202, body: pendingBody, replay: false } satisfies ServiceResult<ReservationDto>;
    });
  }

  // -------------------------------------------------------------- reads ----
  async getReservation(user: AuthenticatedUser, id: string): Promise<ReservationDto> {
    const row = await findReservation(this.db, id);
    if (row === undefined) throw new AppError('not_found', `Reservation ${id} does not exist`);
    this.assertOwner(user, row);
    return toReservationDto(row, row.seconds_remaining);
  }

  async listMyReservations(user: AuthenticatedUser, page: number, pageSize: number): Promise<{ rows: ReservationDto[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const { rows, total } = await listReservationsForUser(this.db, user.id, pageSize, offset);
    return { rows: rows.map((row) => toReservationDto(row, row.seconds_remaining)), total };
  }

  // -------------------------------------------------- shared internals ----
  /**
   * Chooses the allocation primitive for the requested strategy. Each returns the same discriminated
   * {@link AllocationResult} so the caller handles sold-out / conflict uniformly. The strategy id is
   * validated against {@link PUBLIC_STRATEGIES} before this runs, so the default branch is unreachable.
   */
  private async allocate(
    client: Queryable,
    strategy: string,
    tierId: string,
    quantity: number,
  ): Promise<AllocationResult> {
    if (strategy === 'atomic_update') {
      const counters = await tryAllocate(client, tierId, quantity);
      return counters === null ? { kind: 'sold_out' } : { kind: 'allocated', counters };
    }
    if (strategy === 'pessimistic') {
      return allocatePessimistic(client, tierId, quantity);
    }
    return allocateOptimistic(client, tierId, quantity);
  }

  private handleAcquisition(
    acquisition: IdempotencyAcquisition,
  ): { kind: 'replay'; result: ServiceResult<never> } | { kind: 'new'; recordId: string } {
    appMetrics.idempotencyOutcomes.inc({ outcome: acquisition.status.toLowerCase() });
    switch (acquisition.status) {
      case 'REPLAY':
        return {
          kind: 'replay',
          result: {
            status: acquisition.responseStatus,
            body: acquisition.responseBody as ServiceResult<never>['body'],
            replay: true,
          },
        };
      case 'IN_PROGRESS':
        throw new AppError('idempotency_in_progress', 'A request with this Idempotency-Key is still in progress');
      case 'REUSE_MISMATCH':
        throw new AppError('idempotency_key_reuse', 'Idempotency-Key was already used with a different request body');
      case 'NEW':
        return { kind: 'new', recordId: acquisition.recordId };
    }
  }

  private assertOwner(user: AuthenticatedUser, row: ReservationRow): void {
    if (row.user_id !== user.id && user.role !== 'LAB_ADMIN') {
      throw new AppError('forbidden', 'You do not have access to this reservation');
    }
  }

  /** Terminal, non-confirmed reservation: refuse, and reconcile only if money actually moved. */
  private async refuseNotConfirmable(
    client: Parameters<typeof insertOutboxEvent>[0],
    recordId: string,
    reservation: ReservationRow,
    result: ChargeResult,
    requestId: string,
  ): Promise<ServiceResult<never>> {
    if (result.status === 'SUCCEEDED') {
      await recordReconciliationFinding(client, {
        kind: 'payment_after_expiry',
        tierId: reservation.tier_id,
        reservationId: reservation.id,
        detail: {
          providerReference: result.providerReference,
          amount: result.amount,
          outcome: 'success',
          reservationStatus: reservation.status,
        },
      });
    }
    return this.commitRefusal(client, recordId, reservation, requestId, 'reservation_not_confirmable',
      `Reservation ${reservation.id} is ${reservation.status} and can no longer be confirmed`,
      'not_confirmable');
  }

  /** Successful payment that lost the confirm-vs-expire race: the seat is gone; record it, never revive it. */
  private async recordPaymentAfterExpiry(
    client: Parameters<typeof insertOutboxEvent>[0],
    recordId: string,
    reservation: ReservationRow,
    result: ChargeResult,
    requestId: string,
  ): Promise<ServiceResult<never>> {
    await recordReconciliationFinding(client, {
      kind: 'payment_after_expiry',
      tierId: reservation.tier_id,
      reservationId: reservation.id,
      detail: { providerReference: result.providerReference, amount: result.amount, outcome: 'success' },
    });
    return this.commitRefusal(client, recordId, reservation, requestId, 'reservation_not_confirmable',
      'The reservation expired before payment could be fulfilled; the charge was recorded for reconciliation',
      'payment_after_expiry');
  }

  private async commitRefusal(
    client: Parameters<typeof insertOutboxEvent>[0],
    recordId: string,
    reservation: ReservationRow,
    requestId: string,
    code: ErrorCode,
    message: string,
    metricOutcome: string,
  ): Promise<ServiceResult<never>> {
    const body = { error: errorBody(code, message, requestId) };
    // Committed (not thrown): the reconciliation finding and this completed idempotency record must
    // survive; the client re-deriving the same request gets the same committed 409.
    await completeIdempotency(client, {
      recordId,
      responseStatus: 409,
      responseBody: body,
      resourceType: 'reservation',
      resourceId: reservation.id,
    });
    appMetrics.reservationOutcomes.inc({ strategy: reservation.strategy, outcome: metricOutcome });
    return { status: 409, body, replay: false } as ServiceResult<never>;
  }
}
