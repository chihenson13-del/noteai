/**
 * Where the app is served from: "/" on Vercel or a custom domain, "/noteai/" on GitHub Pages.
 * Set at build time with VITE_BASE_PATH (see vite.config.ts). Always starts and ends with "/".
 */
export const BASE_PATH: string = normalizeBase(import.meta.env.BASE_URL);

export function normalizeBase(value: string | undefined): string {
  let base = (value ?? '/').trim();
  if (base === '' || base === './') base = '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

/** React Router `basename`: no trailing slash, or undefined at the site root. */
export function routerBasename(base: string = BASE_PATH): string | undefined {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Absolute URL for an in-app path, honouring the base path:
 * appUrl('/s/abc') -> "https://host/noteai/s/abc" (or "https://host/s/abc" at the root).
 */
export function appUrl(path = '/', origin: string = window.location.origin, base: string = BASE_PATH): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${origin}${base}${clean}`;
}
