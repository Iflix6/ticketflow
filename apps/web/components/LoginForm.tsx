'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi, isApiCallError, type ApiCallError } from '../lib/api';
import { buttonClass, Callout } from './ui';
import { IconEye, IconEyeOff } from './icons';

/**
 * Login posts JSON to the documented session endpoint through the same-origin proxy; the API's
 * Set-Cookie lands on the browser directly — the web app never intermediates or stores the token.
 *
 * Failure copy is deliberately human-first: the API's `unauthorized` message stays generic on
 * purpose (unknown email and wrong password must be indistinguishable to prevent enumeration), so
 * the UI mirrors that ambiguity rather than "improving" it. `validation_failed` responses carry a
 * field-level detail map from the shared zod boundary helper (e.g. `body.password: "Too small…"`);
 * we render each entry as a friendly sentence keyed by a prettified field name, and keep the raw
 * code visible in a small muted footer so support/debug is never blind. A `TypeError` means the
 * fetch never connected, so we say "can't reach the API" instead of pretending it answered.
 *
 * The password field has a show/hide toggle (eye icon) — a plain UX affordance, not a security
 * claim; the value is still sent over the same-origin proxy exactly as before.
 */

/** Prettifies the API's `body.<field>` keys into a label a human would recognise. */
function prettyField(key: string): string {
  const tail = key.split('.').pop() ?? key;
  const map: Record<string, string> = {
    email: 'Email',
    password: 'Password',
    '(root)': 'Request',
  };
  return map[tail] ?? tail.charAt(0).toUpperCase() + tail.slice(1);
}

/** Turns the API's error into a headline message plus optional per-field lines. */
function toHumanError(err: unknown): { headline: string; lines?: string[]; raw?: string } {
  if (err instanceof TypeError) {
    return {
      headline: "We couldn't reach the API.",
      lines: ['Start it with `npm run dev:api` (PostgreSQL must be up: `npm run db:up`).'],
    };
  }
  if (!isApiCallError(err)) {
    return { headline: 'Something went wrong signing you in.', raw: 'Unexpected client-side error.' };
  }
  const apiErr: ApiCallError = err;
  if (apiErr.code === 'unauthorized') {
    // Deliberately does NOT distinguish unknown email from wrong password — the API doesn't, and
    // neither should the UI. See `authenticateCredentials` in apps/api/src/modules/auth/routes.ts.
    return {
      headline: 'Email or password is incorrect.',
      lines: ['Double-check the seeded demo credentials below, or try again.'],
      raw: `${apiErr.code} (HTTP ${apiErr.status})`,
    };
  }
  if (apiErr.code === 'validation_failed') {
    const fieldLines = extractFieldLines(apiErr.details);
    return {
      headline: 'Please fix the highlighted fields.',
      ...(fieldLines.length > 0 ? { lines: fieldLines } : {}),
      raw: `${apiErr.code} (HTTP ${apiErr.status})`,
    };
  }
  if (apiErr.status >= 500) {
    return {
      headline: 'The API hit an internal error.',
      lines: [apiErr.message],
      raw: `${apiErr.code} (HTTP ${apiErr.status})`,
    };
  }
  return { headline: apiErr.message, raw: `${apiErr.code} (HTTP ${apiErr.status})` };
}

/** Reads the { 'body.email': 'Invalid email', … } map the shared validation helper emits. */
function extractFieldLines(details: Record<string, unknown> | undefined): string[] {
  if (details === undefined) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') lines.push(`${prettyField(key)}: ${value}`);
  }
  return lines;
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toHumanError> | undefined>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await browserApi('/api/v1/auth/session', { method: 'POST', body: { email, password } });
      router.push('/events');
      router.refresh();
    } catch (err) {
      setError(toHumanError(err));
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-brand';

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl2 border border-edge bg-panel p-5 shadow-1">
      <div>
        <label htmlFor="login-email" className="block text-sm font-medium text-ink">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`${field} mt-1`}
        />
      </div>
      <div>
        <label htmlFor="login-password" className="block text-sm font-medium text-ink">
          Password
        </label>
        <div className="relative mt-1">
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error !== undefined ? 'login-error' : undefined}
            className={`${field} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            title={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-ink"
          >
            {showPassword ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
      </div>
      {error !== undefined && (
        <div id="login-error" role="alert">
          <Callout tone="danger">
            <p className="font-semibold">{error.headline}</p>
            {error.lines !== undefined && error.lines.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {error.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {error.raw !== undefined && (
              <p className="mt-1.5 font-mono text-[11px] opacity-70">{error.raw}</p>
            )}
          </Callout>
        </div>
      )}
      <button type="submit" disabled={busy} className={`${buttonClass('primary')} w-full`}>
        {busy ? (
          <>
            <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Signing in…
          </>
        ) : (
          'Sign in'
        )}
      </button>
    </form>
  );
}
