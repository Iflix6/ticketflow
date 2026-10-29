import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { BookingPanel } from '../../../components/BookingPanel';
import { getSessionUser } from '../../../lib/session';
import { PageHeader, Callout } from '../../../components/ui';
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

  const back = (
    <Link href="/events" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-brand">
      ← Back to events
    </Link>
  );

  if (loaded === undefined) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorPanel error={loadError} />
      </div>
    );
  }

  const view = loaded;
  const user = await getSessionUser();

  return (
    <div className="space-y-8">
      {back}
      <PageHeader
        title={view.event.title}
        subtitle={
          <>
            {view.event.description}
            <span className="mt-1 block text-xs text-muted">
              Starts {new Date(view.event.startAt).toLocaleString()} · status {view.event.status}
            </span>
          </>
        }
      />

      {user === undefined ? (
        <Callout tone="info">
          <Link href="/login" className="font-medium underline underline-offset-2">
            Sign in
          </Link>{' '}
          to reserve seats. Prices and availability below are read from the server — this page invents nothing.
        </Callout>
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
