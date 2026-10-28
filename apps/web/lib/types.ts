/**
 * Types for the web app, derived from the SAME zod-inferred DTOs the API serializes
 * (`@ticketflow/contracts`) — a hand-copied mirror would be exactly the drift the OpenAPI parity
 * guards exist to catch, and the UI is a client like any other.
 *
 * One deliberate deviation: `ExperimentResultDto` in contracts types `id`/`latencyMicros` as
 * `bigint` (the pg driver shape), but over JSON they arrive as DECIMAL STRINGS (the API stringifies
 * them because JSON has no bigint literal), so the wire shape is restated here with `string`.
 */

import type {
  BookingDto,
  EventDto,
  InventoryDto,
  LabRunDto,
  Pagination,
  ReservationDto,
  StrategyDescriptorDto,
  TicketTierDto,
  UserRole,
} from '@ticketflow/contracts';

export type {
  BookingDto,
  EventDto,
  InventoryDto,
  LabRunDto,
  Pagination,
  ReservationDto,
  StrategyDescriptorDto,
  TicketTierDto,
  UserRole,
};

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface TierWithInventory {
  tier: TicketTierDto;
  inventory: InventoryDto;
}

/** The wire shape of one experiment result row (bigint fields arrive as decimal strings). */
export interface ExperimentResultWire {
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
}

/** The single error envelope every documented route uses (mirrors contracts ErrorBodyDto). */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    occurredAt?: string;
  };
}
