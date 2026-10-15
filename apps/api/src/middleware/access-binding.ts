// Binds a verified Cloudflare Access identity to the signed-in app session (issue #108 finding 1).
// Deliberately its own file: a different failure mode (403, not 401) than access-jwt.ts, mirroring
// why platform-admin.ts is its own file rather than folded into auth.ts. Must run after both
// requireAccessJwt (sets accessEmail) and requireAuth (sets auth.userId AND authUserEmail).
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { ACCESS_BYPASSED } from './access-jwt'

/**
 * Rejects when the Access JWT's email does not match the signed-in user's own email. The user's
 * email comes from the context var requireAuth already populated from its own users-row read
 * (issue #113: one round trip per request, not two) — not re-queried here. The freshness guarantee
 * is the same, since requireAuth re-reads the row every request anyway.
 *
 * ACCESS_BYPASSED means requireAccessJwt deliberately skipped verification (local dev only, gated
 * on ENVIRONMENT there, not on anything this file re-checks) — that is a pass, not a mismatch.
 *
 * A missing authUserEmail (CI-token or API-key caller reaching this middleware before
 * requirePlatformAdmin rejects them next) is treated as a mismatch, not a crash.
 */
export const requireAccessBinding: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth')
  const accessEmail = c.get('accessEmail')
  if (accessEmail === ACCESS_BYPASSED) {
    return next()
  }
  const userEmail = c.get('authUserEmail')
  if (!auth.userId || !accessEmail || !userEmail || userEmail.toLowerCase() !== accessEmail) {
    return c.json({ error: 'FORBIDDEN', message: 'Access identity does not match the signed-in account' }, 403)
  }
  return next()
}
