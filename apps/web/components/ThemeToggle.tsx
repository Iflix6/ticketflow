'use client';

import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { THEME_STORAGE_KEY } from '../lib/theme';

/**
 * Two-state light/dark switch. The resolved state is read from the `dark` class the inline
 * <ThemeScript/> already applied (so it matches what painted, with no hydration guess), and each
 * flip updates the class, the OS color-scheme, and the persisted choice together. Labels are honest:
 * the button says which theme it will switch TO. For the duration of one flip it adds `tf-theme-transition`
 * to <html> so surfaces crossfade (defined in globals.css) instead of snapping, and the icon spins in
 * via GSAP — both skipped entirely under `prefers-reduced-motion`.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | undefined>(undefined);
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !(dark ?? false);
    const root = document.documentElement;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    setDark(next);
    if (!reduce) {
      root.classList.add('tf-theme-transition');
      window.setTimeout(() => root.classList.remove('tf-theme-transition'), 320);
    }
    root.classList.toggle('dark', next);
    root.style.colorScheme = next ? 'dark' : 'light';
    if (!reduce && iconRef.current) {
      gsap.fromTo(iconRef.current, { rotate: -90, scale: 0.6 }, { rotate: 0, scale: 1, duration: 0.35, ease: 'back.out(1.7)' });
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      /* localStorage can be unavailable (private mode); the in-memory class still flips for this view. */
    }
  }

  // Undefined until read on the client: render a stable placeholder so the first paint never
  // mismatches the server (which cannot know the resolved theme).
  const ready = dark !== undefined;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-panel text-muted transition-colors hover:bg-elevated hover:text-ink"
    >
      <span ref={iconRef} className="inline-flex">
        {!ready ? (
          <span className="h-4 w-4 rounded-full border-2 border-edge" aria-hidden />
        ) : dark ? (
          // sun icon
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          // moon icon
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        )}
      </span>
    </button>
  );
}
