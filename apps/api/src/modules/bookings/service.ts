import type { BookingDto } from '@ticketflow/contracts';
import type { Database } from '../../db/pool.js';
import { AppError } from '../../shared/errors.js';
import { toBookingDto } from '../../shared/serialize.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { findBookingWithOwner, findBookingsForUser } from './repository.js';

/**
 * Booking reads only. Fulfilment (creating bookings) lives in the checkout transaction inside
 * `ReservationsService`; keeping the writes out of this service makes "a booking read cannot mutate
 * inventory or state" structurally true.
 */
export class BookingsService {
  constructor(private readonly db: Database) {}

  async getBooking(user: AuthenticatedUser, id: string): Promise<BookingDto> {
    const row = await findBookingWithOwner(this.db, id);
    if (row === undefined) throw new AppError('not_found', `Booking ${id} does not exist`);
    if (row.owner_user_id !== user.id && user.role !== 'LAB_ADMIN') {
      throw new AppError('forbidden', 'You do not have access to this booking');
    }
    return toBookingDto(row);
  }

  async listMine(
    user: AuthenticatedUser,
    page: number,
    pageSize: number,
  ): Promise<{ bookings: BookingDto[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const { rows, total } = await findBookingsForUser(this.db, user.id, pageSize, offset);
    return { bookings: rows.map(toBookingDto), total };
  }
}
