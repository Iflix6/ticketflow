import type { EventDto, Pagination, TierWithInventoryDto } from '@ticketflow/contracts';
import { AppError } from '../../shared/errors.js';
import { toEventDto, toInventoryDto, toTierDto } from '../../shared/serialize.js';
import type { EventsRepository } from './repository.js';

/**
 * Events service: shaping reads only. No allocation logic lives here (that belongs to reservations,
 * Phase 2), which keeps "the catalog cannot sell a ticket" structurally true.
 */
export class EventsService {
  constructor(private readonly repository: EventsRepository) {}

  async listEvents(page: number, pageSize: number, status?: string): Promise<{ events: EventDto[]; pagination: Pagination }> {
    // Conditional spread keeps `status` truly optional under `exactOptionalPropertyTypes`.
    const { rows, total } = await this.repository.listEvents({ page, pageSize, ...(status ? { status } : {}) });
    return {
      events: rows.map(toEventDto),
      pagination: buildPagination(page, pageSize, total),
    };
  }

  async requireEvent(id: string): Promise<EventDto> {
    const row = await this.repository.findEventById(id);
    if (row === undefined) throw new AppError('not_found', `Event ${id} does not exist`);
    return toEventDto(row);
  }

  async tiersForEvent(id: string): Promise<TierWithInventoryDto[]> {
    await this.requireEvent(id);
    const rows = await this.repository.findTiersForEvent(id);
    return rows.map((row) => ({ tier: toTierDto(row), inventory: toInventoryDto(row) }));
  }

  async tierWithInventory(tierId: string): Promise<TierWithInventoryDto> {
    const row = await this.repository.findTierWithInventory(tierId);
    if (row === undefined) throw new AppError('not_found', `Ticket tier ${tierId} does not exist`);
    return { tier: toTierDto(row), inventory: toInventoryDto(row) };
  }
}

export function buildPagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}
