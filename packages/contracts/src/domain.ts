import { z } from 'zod';
import { BOOKING_STATES, PAYMENT_ATTEMPT_STATES, RESERVATION_STATES } from './state-machines.js';

/**
 * Money is transported as an exact decimal string (never a float) and is display-only in this lab:
 * no payment is ever executed from a client-supplied amount.
 */
export const moneyStringSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, 'expected decimal like "49.00"');

/** Domain DTO contracts. Prices are display-only: the server never accepts a price from a client. */

export const eventStatusSchema = z.enum(['DRAFT', 'ON_SALE', 'SOLD_OUT', 'CANCELED', 'FINISHED']);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const eventSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  startAt: z.iso.datetime({ offset: true }),
  status: eventStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type EventDto = z.infer<typeof eventSchema>;

export const ticketTierSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  name: z.string().min(1),
  /** Display only. Never used for allocation or charging decisions. */
  priceDisplayOnly: moneyStringSchema,
  currency: z.string().length(3),
  capacity: z.int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TicketTierDto = z.infer<typeof ticketTierSchema>;

/** Advisory projection of `inventory` for reads; allocation always re-reads PostgreSQL in-tx. */
export const inventorySchema = z.object({
  tierId: z.uuid(),
  capacity: z.int().min(0),
  available: z.int().min(0),
  reserved: z.int().min(0),
  sold: z.int().min(0),
  version: z.int().min(0),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type InventoryDto = z.infer<typeof inventorySchema>;

export const tierWithInventorySchema = z.object({
  tier: ticketTierSchema,
  inventory: inventorySchema,
});
export type TierWithInventoryDto = z.infer<typeof tierWithInventorySchema>;

// Derived from the shared state-machine tuples (see `state-machines.ts`), so the wire enum and the
// `CHECK (status IN (...))` constraint the parity test reads can never be separate hand-copied literals.
export const reservationStatusSchema = z.enum(RESERVATION_STATES);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const reservationSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  tierId: z.uuid(),
  quantity: z.int().min(1),
  status: reservationStatusSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  /** Derived server-side so clients can render a countdown without trusting their clock. */
  secondsRemaining: z.int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ReservationDto = z.infer<typeof reservationSchema>;

export const createReservationRequestSchema = z
  .object({
    tierId: z.uuid(),
    quantity: z.int().min(1).max(100),
    /** Optional per-request override for lab experiments only (bounded, never negative). */
    reservationTtlSeconds: z.int().min(5).max(86_400).optional(),
    strategy: z.string().min(1).max(40).optional(),
  })
  // Explicitly rejects price/capacity/inventory fields from clients.
  .strict();
export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key must be URL-safe');

export const bookingStatusSchema = z.enum(BOOKING_STATES);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const bookingSchema = z.object({
  id: z.uuid(),
  reservationId: z.uuid(),
  status: bookingStatusSchema,
  totalAmount: moneyStringSchema,
  currency: z.string().length(3),
  createdAt: z.iso.datetime({ offset: true }),
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type BookingDto = z.infer<typeof bookingSchema>;

export const checkoutRequestSchema = z
  .object({
    /** Deterministic knob for the fake provider; no real funds ever move. */
    simulatedOutcome: z.enum(['success', 'failure', 'timeout']).default('success'),
    delayMs: z.int().min(0).max(30_000).default(0),
  })
  .strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const paymentAttemptStatusSchema = z.enum(PAYMENT_ATTEMPT_STATES);
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatusSchema>;

export const paymentAttemptSchema = z.object({
  id: z.uuid(),
  bookingId: z.uuid(),
  providerReference: z.string(),
  status: paymentAttemptStatusSchema,
  requestedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PaymentAttemptDto = z.infer<typeof paymentAttemptSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  component: z.string(),
  detail: z.string().optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
