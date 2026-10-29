/**
 * Hand-rolled grouped bar chart — no chart library, because the pack prefers minimal libraries and
 * because a chart whose numbers you cannot audit is exactly how fabricated-looking dashboards get
 * built. Every value passed in comes from a run document fetched from the API; the SVG is pure
 * function of those values. Server component: no interactivity needed beyond the accessible table
 * fallback rendered alongside (same numbers, readable by any assistive technology).
 */

interface Series {
  name: string;
  color: string;
  values: number[];
}

export function GroupedBars({ title, categories, series }: { title: string; categories: string[]; series: Series[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const barWidth = 18;
  const groupGap = 28;
  const groupWidth = series.length * barWidth + (series.length - 1) * 4;
  const chartWidth = categories.length * (groupWidth + groupGap);
  const chartHeight = 180;
  const labelHeight = 46;

  return (
    <figure className="space-y-2" aria-label={title}>
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <svg
        width={Math.max(chartWidth, 320)}
        height={chartHeight + labelHeight}
        role="img"
        aria-label={`${title}: ${series.map((s) => `${s.name}: ${s.values.join(', ')}`).join('; ')}`}
      >
        <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke="#94a3b8" />
        {categories.map((cat, ci) =>
          series.map((s, si) => {
            const v = s.values[ci] ?? 0;
            const h = (v / max) * (chartHeight - 10);
            const x = ci * (groupWidth + groupGap) + si * (barWidth + 4);
            return (
              <g key={`${cat}-${s.name}`}>
                <rect x={x} y={chartHeight - h} width={barWidth} height={h} fill={s.color}>
                  <title>{`${cat} · ${s.name}: ${v.toLocaleString('en-US')}`}</title>
                </rect>
                <text x={x + barWidth / 2} y={chartHeight - h - 4} textAnchor="middle" fontSize="10" fill="#334155">
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
            fill="#334155"
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
