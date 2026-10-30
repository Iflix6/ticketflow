import type { ElementType, ReactNode } from 'react';

/**
 * Presentational primitives shared by every page so the dashboard reads as one product. No hooks and
 * no data here — purely markup and Tailwind classes keyed to the semantic theme tokens — so these are
 * safe inside Server Components and Client Components alike. Behavior-bearing widgets (forms, buttons
 * that call the API, the theme toggle) stay in their own files and use these for their shell only.
 *
 * The palette is deliberately narrow: a surface (panel/elevated), one hairline (edge), ink/muted text,
 * one brand hue, and four state colors. Every primitive draws from those and nothing else, which is
 * what keeps twelve screens feeling authored rather than assembled.
 */

const ROUNDED = 'rounded-xl';

/** Variants are intentionally few; every call site maps to a real intent in the product. */
export function buttonClass(
  variant: 'primary' | 'success' | 'danger' | 'outline' | 'ghost' = 'primary',
  size: 'sm' | 'md' = 'md',
): string {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium transition-all active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 focus-visible:outline-2';
  const pad = size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-sm';
  const skins: Record<'primary' | 'success' | 'danger' | 'outline' | 'ghost', string> = {
    primary: 'bg-brand text-brand-ink hover:brightness-110 shadow-2 shadow-brand/25',
    success: 'bg-ok text-white dark:text-emerald-950 hover:brightness-110 shadow-2 shadow-ok/25',
    danger: 'bg-danger text-white dark:text-rose-950 hover:brightness-110 shadow-2 shadow-danger/25',
    outline: 'border border-edge bg-panel text-ink hover:bg-elevated hover:border-edge-strong',
    ghost: 'text-muted hover:bg-elevated hover:text-ink',
  };
  return `${base} ${pad} ${ROUNDED} ${skins[variant]}`;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'success' | 'danger' | 'outline' | 'ghost';
  size?: 'sm' | 'md';
}) {
  return <button className={`${buttonClass(variant, size)} ${className}`} {...rest} />;
}

/** Card: the surface every block sits on. `as` lets a card be a link or article without losing styling. */
export function Card({
  children,
  className = '',
  as: As = 'div',
  interactive = false,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  as?: ElementType;
} & Record<string, unknown>) {
  const hover = interactive
    ? 'transition-all duration-200 hover:border-brand/40 hover:shadow-3 hover:-translate-y-0.5'
    : '';
  return (
    <As className={`rounded-xl2 border border-edge bg-panel shadow-1 ${hover} ${className}`} {...rest}>
      {children}
    </As>
  );
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1.5">
        {eyebrow !== undefined && (
          <p className="text-xs font-semibold uppercase tracking-widest text-brand">{eyebrow}</p>
        )}
        <h1 className="tf-h1 text-ink">{title}</h1>
        {subtitle !== undefined && <div className="tf-lead max-w-2xl">{subtitle}</div>}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted">
      <span aria-hidden className="h-3 w-0.5 rounded-full bg-brand/60" />
      {children}
    </h3>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-elevated text-muted ring-edge',
  ok: 'bg-ok/10 text-ok ring-ok/25',
  warn: 'bg-warn/10 text-warn ring-warn/25',
  danger: 'bg-danger/10 text-danger ring-danger/30',
  info: 'bg-info/10 text-info ring-info/25',
  brand: 'bg-brand/10 text-brand ring-brand/25',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Maps the raw status/enum strings the API returns to a tone, so a badge is never color-guessed at a
 * call site. Unknown values fall back to neutral rather than silently looking like a success.
 */
export function StatusBadge({ value }: { value: string }) {
  const v = value.toUpperCase();
  let tone: Tone = 'neutral';
  if (['CONFIRMED', 'COMPLETED', 'SUCCEEDED', 'ON_SALE', 'RESERVED'].includes(v)) tone = 'ok';
  else if (['PENDING', 'HELD', 'SOLD_OUT', 'DRAFT', 'CONFLICT', 'DUPLICATE'].includes(v)) tone = 'warn';
  else if (['FAILED', 'ABORTED', 'CANCELED', 'EXPIRED', 'TIMEOUT', 'UNSAFE'].includes(v)) tone = 'danger';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-current ${tone === 'ok' ? 'animate-pulse' : ''}`} />
      {value}
    </span>
  );
}

/** Stat tile: the dashboard's primary reading unit. `tone` colours the value only, not the tile. */
export function Stat({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'ok' | 'danger' | 'warn';
  hint?: ReactNode;
}) {
  const valueClass =
    tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink';
  const barClass =
    tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-brand/50';
  return (
    <div className="relative overflow-hidden rounded-xl border border-edge bg-panel p-3.5 shadow-1">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${barClass}`} />
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums tracking-tight ${valueClass}`}>{value}</dd>
      {hint !== undefined && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function Callout({ tone, children }: { tone: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const map = {
    info: 'border-info/30 bg-info/10 text-info',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    danger: 'border-danger/30 bg-danger/10 text-danger',
    ok: 'border-ok/30 bg-ok/10 text-ok',
  } as const;
  return <div className={`rounded-xl border p-3.5 text-sm shadow-1 ${map[tone]}`}>{children}</div>;
}

/** Inline key-cap / code reference styled once (used for shortcuts, endpoints, and config keys). */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-edge bg-elevated px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink shadow-1">
      {children}
    </kbd>
  );
}

/**
 * Proportional inventory/quantity meter. `value`/`max` are the server's own integers — this only draws
 * the ratio, it never recomputes availability, so a full bar always means exactly what the API said.
 */
export function Meter({
  value,
  max,
  tone = 'brand',
  label,
}: {
  value: number;
  max: number;
  tone?: 'brand' | 'ok' | 'warn' | 'danger';
  label?: ReactNode;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const fill =
    tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'danger' ? 'bg-danger' : 'bg-gradient-to-r from-brand to-accent';
  return (
    <div className="space-y-1">
      {label !== undefined && (
        <div className="flex items-baseline justify-between text-xs text-muted">
          <span>{label}</span>
          <span className="tabular-nums">{Math.round(pct)}%</span>
        </div>
      )}
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={typeof label === 'string' ? label : 'quantity'}
        className="h-2 w-full overflow-hidden rounded-full bg-elevated ring-1 ring-inset ring-edge"
      >
        <div className={`h-full rounded-full ${fill} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Legend swatch pairing a color with a name — used by the comparison charts so colors are never a guess. */
export function LegendSwatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-2.5 py-1 text-xs font-medium text-ink shadow-1">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}
