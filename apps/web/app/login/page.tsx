import Link from 'next/link';
import { LoginForm } from '../../components/LoginForm';

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">Sign in (local lab)</h1>
      <p className="text-sm text-slate-600">
        Seeded demo identities live in <code className="font-mono text-xs">scripts/seed.ts</code> —
        <code className="ml-1 font-mono text-xs">customer@local.test</code> and
        <code className="ml-1 font-mono text-xs">lab@local.test</code> with the documented local demo
        passwords. This exchange creates a DB-backed HttpOnly session cookie; the raw token is never
        visible to page JavaScript.
      </p>
      <LoginForm />
      <p className="text-xs text-slate-500">
        Not a production auth surface: single-factor, no lockout, synthetic data — see the OpenAPI
        description of <code className="font-mono">POST /api/v1/auth/session</code>.
      </p>
      <p>
        <Link href="/events" className="text-sm underline">
          Browse events without signing in
        </Link>
      </p>
    </div>
  );
}
