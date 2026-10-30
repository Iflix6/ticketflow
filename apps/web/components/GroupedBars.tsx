'use client';

import { useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * Hand-rolled grouped bar chart — no chart library, because the pack prefers minimal libraries and
 * because a chart whose numbers you cannot audit is exactly how fabricated-looking dashboards get
 * built. Every value rendered here comes from a run document fetched from the API; the SVG is a pure
 * function of those values. GSAP only animates the reveal (bars grow from the baseline, labels fade
 * up) — it never changes a value, and the animation is skipped under `prefers-reduced-motion`. The
 * accessible table fallback with the identical numbers is rendered alongside by the compare page.
 */

interface Series {
  name: string;
  color: string;
  values: number[];
}

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function GroupedBars({ title, categories, series }: { title: string; categories: string[]; series: Series[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const barWidth = 18;
  const groupGap = 28;
  const groupWidth = series.length * barWidth + (series.length - 1) * 4;
  const chartWidth = categories.length * (groupWidth + groupGap);
  const chartHeight = 180;
  const labelHeight = 46;

  const svgRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (prefersReduced() || svgRef.current === null) return;
    const ctx = gsap.context(() => {
      const bars = gsap.utils.toArray<SVGRectElement>('.tf-bar');
      bars.forEach((bar) => {
        const fy = Number(bar.dataset.fy);
        const fh = Number(bar.dataset.fh);
        gsap.fromTo(
          bar,
          { attr: { height: 0, y: chartHeight } },
          { attr: { height: fh, y: fy }, duration: 0.6, ease: 'power2.out' },
        );
      });
      gsap.from('.tf-bar-label', { autoAlpha: 0, y: 6, duration: 0.4, delay: 0.25, stagger: 0.02, ease: 'power2.out' });
    }, svgRef);
    return () => ctx.revert();
  }, [title, categories, series]);

  return (
    <figure className="space-y-2" aria-label={title}>
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <svg
        ref={svgRef}
        width={Math.max(chartWidth, 320)}
        height={chartHeight + labelHeight}
        role="img"
        aria-label={`${title}: ${series.map((s) => `${s.name}: ${s.values.join(', ')}`).join('; ')}`}
      >
        <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke="var(--edge)" />
        {categories.map((cat, ci) =>
          series.map((s, si) => {
            const v = s.values[ci] ?? 0;
            const h = (v / max) * (chartHeight - 10);
            const x = ci * (groupWidth + groupGap) + si * (barWidth + 4);
            const y = chartHeight - h;
            return (
              <g key={`${cat}-${s.name}`}>
                <rect className="tf-bar" data-fy={y} data-fh={h} x={x} y={y} width={barWidth} height={h} rx={3} fill={s.color}>
                  <title>{`${cat} · ${s.name}: ${v.toLocaleString('en-US')}`}</title>
                </rect>
                <text className="tf-bar-label" x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize="10" fill="var(--muted)">
                  {v.toLocaleString('en-US')}
                </text>
              </g>
            );
          }),
        )}
        {categories.map((cat, ci) => (
          <text
            key={cat}
            x={ci * (groupWidth + groupGap) + groupWidth / 2}
            y={chartHeight + 14}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted)"
          >
            {cat}
          </text>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded" style={{ backgroundColor: s.color }} />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
