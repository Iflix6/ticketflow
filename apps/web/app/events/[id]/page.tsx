import { serverApi } from '../../../lib/server-api';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { BookingPanel } from '../../../components/BookingPanel';
import { getSessionUser } from '../../../lib/session';
import { PageHeader, Callout, StatusBadge } from '../../../components/ui';
import { Stagger } from '../../../components/anim';
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
    <div className="space-y-6">
      {back}
      <section className="overflow-hidden rounded-xl2 border border-edge bg-panel shadow-1">
        <div aria-hidden className="h-1.5 w-full bg-gradient-to-r from-brand via-accent to-brand" />
        <div className="p-5">
          <PageHeader
            eyebrow={view.event.status === 'ON_SALE' ? 'On sale' : undefined}
            title={view.event.title}
            actions={<StatusBadge value={view.event.status} />}
            subtitle={
              <>
                {view.event.description}
                <span className="mt-1.5 block text-xs text-muted">
                  Starts {new Date(view.event.startAt).toLocaleString()}
                </span>
              </>
            }
          />
        </div>
      </section>

      {user === undefined ? (
        <Callout tone="info">
          <Link href="/login" className="font-medium underline underline-offset-2">
            Sign in
          </Link>{' '}
          to reserve seats. Prices and availability below are read from the server — this page invents nothing.
        </Callout>
      ) : (
        <section aria-label="Tiers" className="space-y-4">
          <Stagger as="div" className="space-y-4" step={0.08}>
            {view.tiers.map((tier) => (
              <BookingPanel key={tier.tier.id} tier={tier} userName={user.email} />
            ))}
          </Stagger>
        </section>
      )}
    </div>
  );
}
