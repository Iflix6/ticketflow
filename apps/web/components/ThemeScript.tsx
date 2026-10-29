/**
 * Runs inline in <head> before first paint so the correct theme class is on <html> with zero flash.
 * It mirrors the same contract as <ThemeToggle/>: the stored value is the user's explicit choice,
 * absent/"system" defers to the OS preference. Kept as a plain string (not imported constants) so it
 * is a self-contained, synchronous inline script Next can place in the document head.
 */
export function ThemeScript() {
  const code = `(function(){try{var k='ticketflow-theme';var c=localStorage.getItem(k);var d=c==='dark'||((c===null||c==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(t){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
