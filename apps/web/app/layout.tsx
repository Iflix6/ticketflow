import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { getSessionUser } from '../lib/session';
import { LogoutButton } from '../components/LogoutButton';

export const metadata: Metadata = {
  title: 'TicketFlow — booking reliability lab',
  description:
    'Local demonstration project: event ticket booking with provable inventory invariants (1,000 buyers vs 100 tickets). Synthetic data only, no real payments.',
};

/**
 * App shell. Every page shares: a skip link, one landmarks-correct header/nav/footer, an honest
 * environment badge (this is a local lab with seeded accounts — the pack demands environment
 * identifiers be shown clearly), and the server-side session state so navigation never asks the
 * visitor who they are twice.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-white focus:px-3 focus:py-2 focus:rounded">
          Skip to main content
        </a>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="font-semibold text-lg">
              TicketFlow
            </Link>
            <nav aria-label="Primary">
              <ul className="flex items-center gap-4 text-sm">
                <li>
                  <Link href="/events" className="hover:underline">
                    Events
                  </Link>
                </li>
                <li>
                  <Link href="/bookings" className="hover:underline">
                    My bookings
                  </Link>
                </li>
                <li>
                  <Link href="/lab" className="hover:underline">
                    Engineering Lab
                  </Link>
                </li>
                <li>
                  {user === undefined ? (
                    <Link href="/login" className="hover:underline">
                      Sign in
                    </Link>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">
                        {user.email} <span className="text-slate-700">({user.role})</span>
                      </span>
                      <LogoutButton />
                    </span>
                  )}
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-slate-500">
          Local reliability lab — synthetic data, fake payments, seeded demo accounts. Environment:
          <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-amber-900">local</span>
        </footer>
      </body>
    </html>
  );
}
