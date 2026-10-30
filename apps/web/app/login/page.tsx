import Link from 'next/link';
import { LoginForm } from '../../components/LoginForm';
import { Reveal } from '../../components/anim';
import { IconBolt } from '../../components/icons';
import { Kbd } from '../../components/ui';

/**
 * Seeded demo credentials — the exact defaults `scripts/seed.ts` prints on purpose (local-only,
 * synthetic data, no real users). Both are overridable via `TF_SEED_CUSTOMER_PASSWORD` /
 * `TF_SEED_ADMIN_PASSWORD`, but this lab UI shows the defaults because that is what a fresh
 * `npm run seed` produces. Not a production auth surface: single-factor, no lockout.
 */
const DEMO_EMAIL_CUSTOMER = 'customer@local.test';
const DEMO_PASSWORD_CUSTOMER = 'local-demo-customer-2026';
const DEMO_EMAIL_ADMIN = 'lab@local.test';
const DEMO_PASSWORD_ADMIN = 'local-demo-admin-2026';

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md space-y-5 py-4">
      <Reveal className="space-y-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand to-accent text-white shadow-2 shadow-brand/30">
            <IconBolt />
          </span>
          <h1 className="tf-h1 text-ink">Sign in</h1>
          <p className="text-sm text-muted">Local lab — seeded identities, single-factor, no lockout.</p>
        </div>
      </Reveal>
      <LoginForm />

      <Reveal delay={0.05} className="rounded-xl2 border border-edge bg-panel p-4 shadow-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">Seeded demo accounts</p>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-ink">{DEMO_EMAIL_CUSTOMER}</span>
            <span className="text-xs text-muted">CUSTOMER</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-1.5 text-xs text-muted">
            password <Kbd>{DEMO_PASSWORD_CUSTOMER}</Kbd>
          </li>
          <li className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-edge pt-2">
            <span className="text-ink">{DEMO_EMAIL_ADMIN}</span>
            <span className="text-xs text-brand">LAB_ADMIN</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-1.5 text-xs text-muted">
            password <Kbd>{DEMO_PASSWORD_ADMIN}</Kbd>
          </li>
        </ul>
        <p className="mt-2 text-[11px] text-muted">
          Also seeded: <code className="font-mono">buyer1@local.test</code> …{' '}
          <code className="font-mono">buyer5@local.test</code> (CUSTOMER, same password).
        </p>
      </Reveal>

      <Reveal delay={0.1} className="space-y-3">
        <p className="text-xs text-muted">
          This exchange creates a DB-backed HttpOnly session cookie; the raw token is never visible to page JavaScript.
          Override the passwords with <code className="font-mono">TF_SEED_CUSTOMER_PASSWORD</code> /{' '}
          <code className="font-mono">TF_SEED_ADMIN_PASSWORD</code> before running <code className="font-mono">npm run seed</code>.
        </p>
        <p className="text-xs text-muted">
          Not a production auth surface: single-factor, no lockout, synthetic data — see the OpenAPI description of{' '}
          <code className="font-mono">POST /api/v1/auth/session</code>.
        </p>
      </Reveal>
      <p className="text-center">
        <Link href="/events" className="text-sm text-brand underline underline-offset-2">
          Browse events without signing in
        </Link>
      </p>
    </div>
  );
}
