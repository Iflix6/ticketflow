import type {
  BookingDto,
  EventDto,
  InventoryDto,
  ReservationDto,
  TicketTierDto,
} from '@ticketflow/contracts';

/**
 * Row → DTO mapping.
 *
 * Repository rows are snake_case `pg` results with `Date` and `string` (numeric) values; DTOs are
 * camelCase with ISO-8601 strings. Keeping the mapping in one file means a column rename cannot
 * silently leak a different shape to clients.
 */

export const toIso = (value: Date | string | null | undefined): string => {
  if (value === null || value === undefined) throw new Error('timestamp column was null');
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/** `pg` parses `numeric` as string (see db/pool.ts); money stays a string all the way to the wire. */
export const money = (value: string | null | undefined): string => {
  if (value === null || value === undefined) throw new Error('money column was null');
  return value;
};

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string' && typeof value !== 'object' && typeof value !== 'number') {
    throw new Error(`column ${key} missing`);
  }
  return String(value);
};
const num = (row: Row, key: string): number => {
  const value = row[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`column ${key} is not numeric`);
  return parsed;
};
const date = (row: Row, key: string): Date => {
  const value = row[key];
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  throw new Error(`column ${key} is not a timestamp`);
};

type EventRow = Row & {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
};

export function toEventDto(row: EventRow): EventDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    startAt: toIso(date(row, 'start_at')),
    status: row.status as EventDto['status'],
    createdAt: toIso(date(row, 'created_at')),
    updatedAt: toIso(date(row, 'updated_at')),
  };
}

export function toTierDto(row: Row): TicketTierDto {
  return {
    id: str(row, 'id'),
    eventId: str(row, 'event_id'),
    name: str(row, 'name'),
    priceDisplayOnly: money(row['price_display_only'] as string),
    currency: str(row, 'currency'),
    capacity: num(row, 'capacity'),
    createdAt: toIso(date(row, 'created_at')),
    updatedAt: toIso(date(row, 'updated_at')),
  };
}

export function toInventoryDto(row: Row): InventoryDto {
  return {
    tierId: str(row, 'tier_id'),
    capacity: num(row, 'capacity'),
    available: num(row, 'available'),
    reserved: num(row, 'reserved'),
    sold: num(row, 'sold'),
    version: num(row, 'version'),
    updatedAt: toIso(date(row, 'updated_at')),
  };
}

export function toReservationDto(row: Row, secondsRemaining: number): ReservationDto {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    tierId: str(row, 'tier_id'),
    quantity: num(row, 'quantity'),
    status: str(row, 'status') as ReservationDto['status'],
    expiresAt: toIso(date(row, 'expires_at')),
    secondsRemaining: Math.max(0, Math.floor(secondsRemaining)),
    createdAt: toIso(date(row, 'created_at')),
    updatedAt: toIso(date(row, 'updated_at')),
  };
}

export function toBookingDto(row: Row): BookingDto {
  const confirmedAt = row['confirmed_at'];
  return {
    id: str(row, 'id'),
    reservationId: str(row, 'reservation_id'),
    status: str(row, 'status') as BookingDto['status'],
    totalAmount: money(row['total_amount'] as string),
    currency: str(row, 'currency'),
    createdAt: toIso(date(row, 'created_at')),
    confirmedAt: confirmedAt === null ? null : toIso(confirmedAt as Date),
  };
}

export { str as stringColumn, num as numberColumn, date as dateColumn };
