import type { ReactNode } from 'react';

/**
 * Presentational primitives shared by every page so the dashboard reads as one product. No hooks and
 * no data here — purely markup and Tailwind classes keyed to the semantic theme tokens — so these are
 * safe inside Server Components and Client Components alike. Behavior-bearing widgets (forms, buttons
 * that call the API, the theme toggle) stay in their own files and use these for their shell only.
 */

const ROUNDED = 'rounded-xl';

/** Variants are intentionally few; every call site maps to a real intent in the product. */
export function buttonClass(variant: 'primary' | 'success' | 'outline' | 'ghost' = 'primary', size: 'sm' | 'md' = 'md'): string {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2';
  const pad = size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-sm';
  const skins: Record<typeof variant, string> = {
    primary: `bg-brand text-brand-ink hover:brightness-110 shadow-sm shadow-brand/30`,
    success: 'bg-ok text-white dark:text-emerald-950 hover:brightness-110 shadow-sm shadow-ok/30',
    outline: 'border border-edge bg-panel text-ink hover:bg-elevated',
    ghost: 'text-muted hover:bg-elevated hover:text-ink',
  };
  return `${base} ${pad} ${ROUNDED} ${skins[variant]}`;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'success' | 'outline' | 'ghost'; size?: 'sm' | 'md' }) {
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
} & Record<string, unknown>) {
  const hover = interactive ? 'transition-all hover:border-brand/50 hover:shadow-lg hover:shadow-brand/5 hover:-translate-y-0.5' : '';
  return (
    <As className={`rounded-xl2 border border-edge bg-panel shadow-sm ${hover} ${className}`} {...rest}>
      {children}
    </As>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {subtitle !== undefined && <p className="max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
  return <h3 id={id} className="text-xs font-semibold uppercase tracking-widest text-muted">{children}</h3>;
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
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}>
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
  return <Badge tone={tone}>{value}</Badge>;
}

/** Stat tile: the dashboard's primary reading unit. `tone` colours the value only, not the tile. */
export function Stat({ label, value, tone = 'default' }: { label: string; value: ReactNode; tone?: 'default' | 'ok' | 'danger' }) {
  const valueClass = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div className="rounded-xl border border-edge bg-panel p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</dd>
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
  return <div className={`rounded-xl border p-3 text-sm ${map[tone]}`}>{children}</div>;
}
