import Link from 'next/link';
import { serverApi } from '../../lib/api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import type { EventDto } from '../../lib/types';

export const dynamic = 'force-dynamic'; // inventory and event status change; a cached catalog would lie

const STATUS_LABEL: Record<EventDto['status'], string> = {
  DRAFT: 'Draft',
  ON_SALE: 'On sale',
  SOLD_OUT: 'Sold out',
  CANCELED: 'Canceled',
  FINISHED: 'Finished',
};

export default async function EventsPage() {
  let events: EventDto[];
  try {
    const res = await serverApi<{ data: EventDto[] }>('/api/v1/events?pageSize=50');
    events = res.data;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Events</h1>
        <ErrorPanel error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Events</h1>
      <p className="text-sm text-slate-600">
        A synthetic catalog. The point of this project is what happens under the book button — see
        the <Link href="/lab" className="underline">Engineering Lab</Link>.
      </p>
      {events.length === 0 ? (
        <EmptyState>No events seeded yet — run `npm run seed`.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {events.map((event) => (
            <li key={event.id}>
              <Link
                href={`/events/${event.id}`}
                className="block h-full rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-400"
              >
                <h2 className="font-semibold">{event.title}</h2>
                <p className="mt-1 text-sm text-slate-600">{event.description}</p>
                <p className="text-sm text-slate-600">{new Date(event.startAt).toLocaleString()}</p>
                <p className="mt-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{STATUS_LABEL[event.status]}</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
