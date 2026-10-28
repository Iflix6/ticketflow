import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi, isApiCallError } from '../../lib/api';
import { ErrorPanel, EmptyState } from '../../components/ErrorPanel';
import { getSessionUser } from '../../lib/session';
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
        <h1 className="text-2xl font-semibold">My bookings</h1>
        <ErrorPanel error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My bookings</h1>
      <p className="text-sm text-slate-600">
        Signed in as {user.email} ({user.role}). Amounts are the server-computed decimal strings —
        never a client figure.
      </p>
      {bookings.length === 0 ? (
        <EmptyState>
          No bookings yet.{' '}
          <Link href="/events" className="underline">
            Reserve something
          </Link>
          .
        </EmptyState>
      ) : (
        <table className="w-full border-collapse bg-white text-sm">
          <caption className="caption-top pb-2 text-left text-xs text-slate-500">
            Bookings for the signed-in user, newest first.
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th scope="col" className="py-2 pr-4">
                Booking
              </th>
              <th scope="col" className="py-2 pr-4">
                Status
              </th>
              <th scope="col" className="py-2 pr-4">
                Amount
              </th>
              <th scope="col" className="py-2">
                Confirmed
              </th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-mono text-xs">{b.id.slice(0, 8)}</td>
                <td className="py-2 pr-4">
                  <span
                    className={
                      b.status === 'CONFIRMED'
                        ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-900'
                        : 'rounded bg-slate-100 px-2 py-0.5 text-xs'
                    }
                  >
                    {b.status}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  {b.currency} {b.totalAmount}
                </td>
                <td className="py-2">{b.confirmedAt ? new Date(b.confirmedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
