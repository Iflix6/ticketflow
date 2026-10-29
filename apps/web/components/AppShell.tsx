'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import gsap from 'gsap';
import { LogoutButton } from './LogoutButton';
import { ThemeToggle } from './ThemeToggle';
import {
  IconBeaker,
  IconBookmark,
  IconClose,
  IconMenu,
  IconPlus,
  IconSql,
  IconTicket,
  IconBolt,
} from './icons';

interface ShellUser {
  email: string;
  role: string;
}

/**
 * Dashboard chrome shared by every route: a persistent left rail (brand, grouped nav with honest
 * active states, environment badge) plus a sticky top bar (theme toggle, account). Server components
 * stay server components — this is the single client boundary for navigation, and it owns only
 * presentation/active-link logic. The real authorization boundary remains the API; nothing here gates
 * access, it only decides what is visible, exactly as the previous header did.
 */
export function AppShell({ user, children }: { user: ShellUser | undefined; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Chrome entrance: the rail slides in and the top bar drops in once on first mount.
  useLayoutEffect(() => {
    if (reduce) return;
    const ctx = gsap.context(() => {
      if (railRef.current) gsap.from(railRef.current, { x: -18, autoAlpha: 0, duration: 0.4, ease: 'power2.out' });
      if (headerRef.current) gsap.from(headerRef.current, { y: -10, autoAlpha: 0, duration: 0.35, ease: 'power2.out' });
    });
    return () => ctx.revert();
  }, []);

  // Route transition: fade/lift the page body on every navigation so screens change with continuity.
  useLayoutEffect(() => {
    if (reduce || mainRef.current === null) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(mainRef.current, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power2.out' });
    });
    return () => ctx.revert();
  }, [pathname]);

  // Close the mobile drawer whenever the route changes so navigation never leaves it hanging.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const groups = [
    {
      label: 'Booking',
      items: [
        { href: '/events', label: 'Events', icon: IconTicket, active: pathname.startsWith('/events') || pathname === '/' },
        { href: '/bookings', label: 'My bookings', icon: IconBookmark, active: pathname.startsWith('/bookings') },
      ],
    },
    {
      label: 'Engineering Lab',
      items: [
        { href: '/lab', label: 'Experiment runs', icon: IconBeaker, active: pathname === '/lab' || pathname.startsWith('/lab/runs') },
        { href: '/lab/scenario', label: 'New run', icon: IconPlus, active: pathname.startsWith('/lab/scenario') },
        { href: '/lab/strategies', label: 'Strategies & SQL', icon: IconSql, active: pathname.startsWith('/lab/strategies') },
      ],
    },
  ];

  const rail = (
    <div className="flex h-full flex-col gap-1 p-4">
      <Link href="/events" className="mb-4 flex items-center gap-2.5 rounded-lg px-1 py-1">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-white shadow-sm shadow-brand/30">
          <IconBolt />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold text-ink">TicketFlow</span>
          <span className="block text-xs text-muted">reliability lab</span>
        </span>
      </Link>

      {groups.map((group) => (
        <div key={group.label} className="mt-2">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-muted">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                    item.active
                      ? 'bg-brand/10 font-medium text-brand ring-1 ring-inset ring-brand/20'
                      : 'text-muted hover:bg-elevated hover:text-ink'
                  }`}
                >
                  <item.icon className={item.active ? 'text-brand' : ''} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="mt-auto pt-4">
        <div className="flex items-center gap-2 rounded-lg border border-edge bg-elevated px-3 py-2 text-xs text-muted">
          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-amber-600 dark:text-amber-300">local</span>
          synthetic data · fake payments
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-app text-ink">
      {/* Desktop rail */}
      <aside ref={railRef} className="fixed inset-y-0 left-0 hidden w-64 border-r border-edge bg-panel lg:block">{rail}</aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-edge bg-panel shadow-xl">{rail}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header ref={headerRef} className="sticky top-0 z-30 border-b border-edge bg-panel/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? 'Close navigation' : 'Open navigation'}
              className="grid h-9 w-9 place-items-center rounded-lg border border-edge text-muted hover:bg-elevated hover:text-ink lg:hidden"
            >
              {open ? <IconClose /> : <IconMenu />}
            </button>
            <span className="ml-auto" />
            <div className="flex items-center gap-2.5">
              <ThemeToggle />
              {user === undefined ? (
                <Link
                  href="/login"
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink hover:brightness-110"
                >
                  Sign in
                </Link>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="hidden items-center gap-2 rounded-lg border border-edge bg-elevated px-2.5 py-1 text-xs sm:flex">
                    <span className="font-medium text-ink">{user.email}</span>
                    <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-brand">{user.role}</span>
                  </span>
                  <LogoutButton />
                </span>
              )}
            </div>
          </div>
        </header>

        <main id="main" ref={mainRef} className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
          {children}
        </main>

        <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-muted">
          Local reliability lab — synthetic data, fake payments, seeded demo accounts. Environment:
          <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-amber-600 dark:text-amber-300">local</span>
        </footer>
      </div>
    </div>
  );
}
