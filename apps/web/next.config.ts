import type { NextConfig } from 'next';

/**
 * The single architectural decision that makes the browser session work unchanged: the API is
 * proxied onto the web app's own origin, so `tf_session` (HttpOnly, Path=/) is a FIRST-PARTY cookie
 * — no CORS dance, no cross-origin SameSite=None (which would demand Secure cookies and thus break
 * plain http on loopback). Server Components additionally call the API directly via API_BASE_URL
 * with the forwarded Cookie header; both paths hit only documented endpoints.
 */
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiBaseUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
