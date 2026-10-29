import type { Metadata } from 'next';
import './globals.css';
import { getSessionUser } from '../lib/session';
import { AppShell } from '../components/AppShell';
import { ThemeScript } from '../components/ThemeScript';

export const metadata: Metadata = {
  title: 'TicketFlow — booking reliability lab',
  description:
    'Local demonstration project: event ticket booking with provable inventory invariants (1,000 buyers vs 100 tickets). Synthetic data only, no real payments.',
};

/**
 * App shell. Every page shares: a skip link, one landmarks-correct sidebar + top bar + footer (via
 * <AppShell>), an honest environment badge (this is a local lab with seeded accounts — the pack demands
 * environment identifiers be shown clearly), the persisted light/dark theme (applied pre-paint by
 * <ThemeScript>), and the server-side session state so navigation never asks the visitor who they are
 * twice. `suppressHydrationWarning` on <html> is required because the theme script mutates the class
 * list before React hydrates — the server render is theme-agnostic on purpose.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2 focus:text-ink focus:ring-1 focus:ring-brand"
        >
          Skip to main content
        </a>
        <AppShell user={user === undefined ? undefined : { email: user.email, role: user.role }}>{children}</AppShell>
      </body>
    </html>
  );
}
