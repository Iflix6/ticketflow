import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { BookingPanel } from '../../../components/BookingPanel';
import { getSessionUser } from '../../../lib/session';
import type { EventDto, TierWithInventory } from '../../../lib/types';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let loaded: { event: EventDto; tiers: TierWithInventory[] } | undefined;
  let loadError: unknown;
  try {
    const eventRes = await serverApi<{ data: EventDto }>(`/api/v1/events/${id}`);
    const tiersRes = await serverApi<{ data: TierWithInventory[] }>(`/api/v1/events/${id}/tiers`);
    loaded = { event: eventRes.data, tiers: tiersRes.data };
  } catch (error) {
    loadError = error;
  }

  if (loaded === undefined) {
    return (
      <div className="space-y-4">
        <Link href="/events" className="text-sm underline">
          ← Back to events
        </Link>
        <ErrorPanel error={loadError} />
      </div>
    );
  }

  const view = loaded;
  const user = await getSessionUser();

  return (
    <div className="space-y-6">
      <Link href="/events" className="text-sm underline">
        ← Back to events
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">{view.event.title}</h1>
        <p className="mt-1 text-slate-600">{view.event.description}</p>
        <p className="text-sm text-slate-500">
          Starts {new Date(view.event.startAt).toLocaleString()} · status {view.event.status}
        </p>
      </header>

      {user === undefined ? (
        <p className="rounded border border-slate-200 bg-white p-4 text-sm">
          <Link href="/login" className="underline font-medium">
            Sign in
          </Link>{' '}
          to reserve seats. Prices and availability below are read from the server — this page
          invents nothing.
        </p>
      ) : (
        <section aria-label="Tiers" className="space-y-4">
          {view.tiers.map((tier) => (
            <BookingPanel key={tier.tier.id} tier={tier} userName={user.email} />
          ))}
        </section>
      )}
    </div>
  );
}
