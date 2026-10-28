'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi, isApiCallError } from '../lib/api';

/**
 * Login posts JSON to the documented session endpoint through the same-origin proxy; the API's
 * Set-Cookie lands on the browser directly — the web app never intermediates or stores the token.
 * Failure text is the server's own message, because a wrong password and an unknown user are the
 * same 401 by design and the UI must not "improve" that into an enumeration oracle.
 */
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await browserApi('/api/v1/auth/session', { method: 'POST', body: { email, password } });
      router.push('/events');
      router.refresh();
    } catch (err) {
      setError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'Could not reach the API.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div>
        <label htmlFor="login-email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
        />
      </div>
      <div>
        <label htmlFor="login-password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
        />
      </div>
      {error !== undefined && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
