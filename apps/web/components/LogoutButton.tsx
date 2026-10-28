'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi } from '../lib/api';

/** Logout is honest about its outcome: the button only disappears once the server confirms. */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick() {
    setBusy(true);
    setFailed(false);
    try {
      await browserApi('/api/v1/auth/session/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {failed && (
        <span role="status" className="ml-1 text-xs text-red-700">
          Sign-out failed; you are still signed in.
        </span>
      )}
    </span>
  );
}
