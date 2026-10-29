/** Shared storage key + explicit theme values so the inline script, the toggle, and any future
 *  consumer agree on one contract. Stored value is the *user choice* (light/dark/system); the
 *  `dark` class on <html> is the resolved result, computed in the inline script. */
export const THEME_STORAGE_KEY = 'ticketflow-theme';
export type ThemeChoice = 'light' | 'dark' | 'system';
