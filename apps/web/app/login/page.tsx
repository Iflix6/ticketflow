import Link from 'next/link';
import { LoginForm } from '../../components/LoginForm';

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md space-y-4 py-4">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted">Local lab — seeded identities, single-factor, no lockout.</p>
      </div>
      <LoginForm />
      <p className="text-xs text-muted">
        Seeded demo identities live in <code className="rounded bg-elevated px-1 py-0.5 font-mono">scripts/seed.ts</code> —{' '}
        <code className="font-mono">customer@local.test</code> and <code className="font-mono">lab@local.test</code> with the
        documented local demo passwords. This exchange creates a DB-backed HttpOnly session cookie; the raw token is never
        visible to page JavaScript.
      </p>
      <p className="text-xs text-muted">
        Not a production auth surface: single-factor, no lockout, synthetic data — see the OpenAPI description of{' '}
        <code className="font-mono">POST /api/v1/auth/session</code>.
      </p>
      <p className="text-center">
        <Link href="/events" className="text-sm text-brand underline underline-offset-2">
          Browse events without signing in
        </Link>
      </p>
    </div>
  );
}
