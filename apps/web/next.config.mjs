const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787'

function apiOrigin() {
  try {
    return new URL(apiUrl).origin
  } catch {
    return "'self'"
  }
}

// CSP notes:
// - script-src needs 'unsafe-inline': Next.js App Router emits inline bootstrap /
//   flight-data scripts, and a nonce policy would force dynamic rendering of every
//   page. No 'unsafe-eval' in production (it is only needed by `next dev`).
// - connect-src allows the API origin (bearer-token fetches from the browser).
// - Mirrors apps/api security-headers.ts for HSTS, nosniff, Referrer-Policy,
//   Permissions-Policy; frame-ancestors 'none' + X-Frame-Options DENY.
const isDev = process.env.NODE_ENV !== 'production'
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin()}${isDev ? ' ws:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
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
        ],
      },
    ]
  },
}

export default nextConfig
