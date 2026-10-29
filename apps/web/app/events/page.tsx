import Link from 'next/link';
import { serverApi } from '../../lib/server-api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import { PageHeader, Badge } from '../../components/ui';
import type { EventDto } from '../../lib/types';

export const dynamic = 'force-dynamic'; // inventory and event status change; a cached catalog would lie

const STATUS: Record<EventDto['status'], { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ON_SALE: { label: 'On sale', tone: 'ok' },
  SOLD_OUT: { label: 'Sold out', tone: 'warn' },
  CANCELED: { label: 'Canceled', tone: 'danger' },
  FINISHED: { label: 'Finished', tone: 'neutral' },
};

export default async function EventsPage() {
  let events: EventDto[];
  try {
    const res = await serverApi<{ data: EventDto[] }>('/api/v1/events?pageSize=50');
    events = res.data;
  } catch (error) {
    return (
      <div className="space-y-4">
        <PageHeader title="Events" />
        <ErrorPanel error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        subtitle={
          <>
            A synthetic catalog. The point of this project is what happens under the book button — see the{' '}
            <Link href="/lab" className="font-medium text-brand underline underline-offset-2">
              Engineering Lab
            </Link>
            .
          </>
        }
      />
      {events.length === 0 ? (
        <EmptyState>No events seeded yet — run `npm run seed`.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => {
            const status = STATUS[event.status];
            return (
              <li key={event.id}>
                <Link
                  href={`/events/${event.id}`}
                  className="group block h-full overflow-hidden rounded-xl2 border border-edge bg-panel shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-lg hover:shadow-brand/5"
                >
                  <div className="h-1 w-full bg-gradient-to-r from-brand to-accent" />
                  <div className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="font-semibold leading-snug group-hover:text-brand">{event.title}</h2>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <p className="line-clamp-2 text-sm text-muted">{event.description}</p>
                    <p className="text-xs text-muted">{new Date(event.startAt).toLocaleString()}</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
