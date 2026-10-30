'use client';

import { createElement, useLayoutEffect, useRef, type ElementType, type ReactNode } from 'react';
import gsap from 'gsap';

/**
 * A tiny, honest motion layer on top of GSAP. Two ideas only: `Reveal` fades/lifts one block in, and
 * `Stagger` does the same to a container's direct children in sequence. Both run in useLayoutEffect so
 * the "from" state is applied before first paint (no flash), both scope themselves with gsap.context and
 * revert on unmount (so Next Fast Refresh / StrictMode never leaves stray tweens), and both bail out
 * entirely under `prefers-reduced-motion: reduce` — motion is decoration here, never a requirement to
 * see the content. Children arrive pre-rendered from Server Components; these wrappers add no data.
 */

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Reveal({
  children,
  className,
  delay = 0,
  y = 14,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (prefersReduced() || ref.current === null) return;
    const ctx = gsap.context(() => {
      gsap.from(ref.current, { autoAlpha: 0, y, duration: 0.5, delay, ease: 'power2.out' });
    }, ref);
    return () => ctx.revert();
  }, [delay, y]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/**
 * Animates a container's element children in sequence. `as` keeps the correct semantic tag (ul, div,
 * tbody…) so accessibility structure is preserved — GSAP only touches opacity/transform, never markup.
 */
export function Stagger({
  children,
  className,
  as = 'div',
  delay = 0,
  step = 0.06,
  y = 16,
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  delay?: number;
  step?: number;
  y?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (prefersReduced() || ref.current === null) return;
    const el = ref.current;
    const ctx = gsap.context(() => {
      gsap.from(Array.from(el.children), { autoAlpha: 0, y, duration: 0.45, delay, stagger: step, ease: 'power2.out' });
    }, ref);
    return () => ctx.revert();
  }, [delay, step, y]);
  // createElement keeps the polymorphic tag (ul/dl/tbody…) semantic while accepting the ref cleanly.
  return createElement(as, { ref, className }, children);
}

/**
 * A one-shot entrance for a whole region (used by the app shell on route change). Plays whenever the
 * `key` value changes, so passing the pathname re-runs the animation on each navigation.
 */
export function Enter({ children, trigger, className }: { children: ReactNode; trigger: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (prefersReduced() || ref.current === null) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(ref.current, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power2.out' });
    }, ref);
    return () => ctx.revert();
  }, [trigger]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
