import { createMiddleware } from 'hono/factory'
import type { Env } from '../index'

export const securityHeaders = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next()

  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  // Nothing this API returns may be stored by a browser, a shared corporate proxy or
  // any other intermediary: GET /api/secrets/:name and GET /api/environments/:id/resolved
  // return plaintext values. Routes that need their own value (e.g. share.ts) set it again.
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
})