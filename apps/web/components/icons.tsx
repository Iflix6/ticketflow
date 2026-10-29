/**
 * Inline stroke icons (currentColor) so the sidebar reads as a product, not a link list — no icon
 * dependency, and they inherit text colour so they flip with the theme automatically. Decorative:
 * every one is aria-hidden; the adjacent link text carries the meaning.
 */
type P = { className?: string };
const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const IconTicket = ({ className }: P) => (
  <svg {...base} className={className}><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4z" /><path d="M13 7v10" strokeDasharray="2 2" /></svg>
);
export const IconBookmark = ({ className }: P) => (
  <svg {...base} className={className}><path d="M6 4h12a1 1 0 0 1 1 1v14l-7-4-7 4V5a1 1 0 0 1 1-1z" /></svg>
);
export const IconBeaker = ({ className }: P) => (
  <svg {...base} className={className}><path d="M9 3v6L4.5 17a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L15 9V3" /><path d="M8 3h8M7.5 14h9" /></svg>
);
export const IconPlus = ({ className }: P) => (
  <svg {...base} className={className}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconSql = ({ className }: P) => (
  <svg {...base} className={className}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>
);
export const IconMenu = ({ className }: P) => (
  <svg {...base} className={className}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
);
export const IconClose = ({ className }: P) => (
  <svg {...base} className={className}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconBolt = ({ className }: P) => (
  <svg {...base} className={className}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
);
