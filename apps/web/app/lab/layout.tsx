import Link from 'next/link';
import { getSessionUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Lab shell. The real gate is the API (401/403 on every /lab route); this layout only decides
 * what a human sees before hitting those: sign-in redirect for anonymous, an honest notice for
 * non-admins, tabs for LAB_ADMIN. No page here claims capabilities the API would not grant.
 */
export default async function LabLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  if (user === undefined) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Engineering Lab</h1>
        <p className="text-sm">
          The lab requires a signed-in LAB_ADMIN session.{' '}
          <Link href="/login" className="underline">
            Sign in
          </Link>{' '}
          with the documented local lab identity.
        </p>
      </div>
    );
  }

  if (user.role !== 'LAB_ADMIN') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Engineering Lab</h1>
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Signed in as {user.email}, role {user.role}. The API answers 403 for every lab route under
          this identity — the dashboard cannot show results it is not allowed to fetch. Sign in with
          the local lab admin to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Lab sections">
        <ul className="flex flex-wrap gap-4 border-b border-slate-200 pb-2 text-sm">
          <li>
            <Link href="/lab" className="font-medium underline-offset-4 hover:underline">
              Runs
            </Link>
          </li>
          <li>
            <Link href="/lab/scenario" className="hover:underline">
              New run
            </Link>
          </li>
          <li>
            <Link href="/lab/strategies" className="hover:underline">
              Strategies &amp; SQL
            </Link>
          </li>
        </ul>
      </nav>
      {children}
    </div>
  );
}
