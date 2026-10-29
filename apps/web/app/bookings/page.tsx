import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi, isApiCallError } from '../../lib/server-api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import { getSessionUser } from '../../lib/session';
import { PageHeader, StatusBadge } from '../../components/ui';
import type { BookingDto } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function BookingsPage() {
  const user = await getSessionUser();
  if (user === undefined) redirect('/login');

  let bookings: BookingDto[];
  try {
    const res = await serverApi<{ data: BookingDto[] }>('/api/v1/me/bookings?pageSize=50');
    bookings = res.data;
  } catch (error) {
    if (isApiCallError(error) && error.status === 401) redirect('/login');
    return (
      <div className="space-y-4">
        <PageHeader title="My bookings" />
        <ErrorPanel error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My bookings"
        subtitle={
          <>
            Signed in as {user.email} ({user.role}). Amounts are the server-computed decimal strings — never a
            client figure.{' '}
            <Link href="/events" className="font-medium text-brand underline underline-offset-2">
              Reserve something
            </Link>
            .
          </>
        }
      />
      {bookings.length === 0 ? (
        <EmptyState>No bookings yet.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl2 border border-edge">
          <div className="tf-scroll overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Bookings for the signed-in user, newest first.</caption>
              <thead>
                <tr className="bg-elevated text-left text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Booking</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Amount</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Confirmed</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} className="border-t border-edge">
                    <td className="px-4 py-2.5 font-mono text-xs">{b.id.slice(0, 8)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge value={b.status} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {b.currency} {b.totalAmount}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{b.confirmedAt ? new Date(b.confirmedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
