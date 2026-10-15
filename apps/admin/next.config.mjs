// Mirrors apps/web/next.config.js. This app is the highest-blast-radius surface in the product
// (it can change any tenant's plan), so it ships the same strict CSP/headers as the customer
// dashboard, and is additionally meant to sit behind Cloudflare Access at the edge — see
// DEPLOY.md. App-level auth (sign-in + platform_admins check) is not a substitute for Access;
// both are required.
//
// connect-src is 'self' only (issue #108 finding 2): the browser never calls the API origin
// directly. src/app/api/** proxies the allowlisted paths server-side (Worker-to-Worker fetch,
// not subject to this CSP at all), which is what scopes the refresh cookie to this host.
const isDev = process.env.NODE_ENV !== 'production'
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @hushvault/web-kit and @hushvault/shared/types are consumed as TypeScript source (no build
  // step needed for admin's own verify), mirroring apps/web/next.config.js.
  transpilePackages: ['@hushvault/shared', '@hushvault/web-kit'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Admin pages must never be cached by an intermediary or returned from bfcache with a
          // stale tenant list after sign-out.
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ]
  },
}

export default nextConfig
