import Link from 'next/link';
import { getSessionUser } from '../../lib/session';
import { Callout, buttonClass } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Lab shell. The real gate is the API (401/403 on every /lab route); this layout only decides
 * what a human sees before hitting those: sign-in redirect for anonymous, an honest notice for
 * non-admins, and the admin children. No page here claims capabilities the API would not grant.
 * Section navigation now lives in the persistent sidebar (<AppShell>), so this layout is purely the
 * access-state gate plus the lab content.
 */
export default async function LabLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  if (user === undefined) {
    return (
      <Callout tone="info">
        <p className="font-medium text-ink">The lab requires a signed-in LAB_ADMIN session.</p>
        <p className="mt-1">
          <Link href="/login" className="font-medium underline underline-offset-2">
            Sign in
          </Link>{' '}
          with the documented local lab identity to continue.
        </p>
      </Callout>
    );
  }

  if (user.role !== 'LAB_ADMIN') {
    return (
      <div role="alert">
        <Callout tone="warn">
          Signed in as <strong className="font-medium">{user.email}</strong>, role {user.role}. The API
          answers 403 for every lab route under this identity — the dashboard cannot show results it is
          not allowed to fetch. Sign in with the local lab admin to continue.
        </Callout>
        <div className="mt-3">
          <Link href="/login" className={buttonClass('outline', 'sm')}>
            Switch account
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
