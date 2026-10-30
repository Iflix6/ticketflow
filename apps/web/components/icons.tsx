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
export const IconEye = ({ className }: P) => (
  <svg {...base} className={className}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconEyeOff = ({ className }: P) => (
  <svg {...base} className={className}><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a17.8 17.8 0 0 1 4.1-5.1" /><path d="M9.9 4.9A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-2.2 3.2" /><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" /><path d="M3 3l18 18" /></svg>
);
export const IconAlert = ({ className }: P) => (
  <svg {...base} className={className}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
);
export const IconRefresh = ({ className }: P) => (
  <svg {...base} className={className}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></svg>
);
export const IconInbox = ({ className }: P) => (
  <svg {...base} className={className}><path d="M3 12h5l1.5 3h5L16 12h5" /><path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></svg>
);
