// Binds a verified Cloudflare Access identity to the signed-in app session (issue #108 finding 1).
// Deliberately its own file: a different dependency (DB) and a different failure mode (403, not
// 401) than access-jwt.ts, mirroring why platform-admin.ts is its own file rather than folded into
// auth.ts. Must run after both requireAccessJwt (sets accessEmail) and requireAuth (sets auth.userId).
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { ACCESS_BYPASSED } from './access-jwt'

/**
 * Rejects when the Access JWT's email does not match the signed-in user's own email. Re-reads
 * users.email on every request rather than trusting any cached claim, consistent with
 * requirePlatformAdmin's re-read of platform_admins — a stolen app session token alone is not
 * enough; it must also come through the Access-protected admin origin as the same person.
 *
 * ACCESS_BYPASSED means requireAccessJwt deliberately skipped verification (local dev only, gated
 * on ENVIRONMENT there, not on anything this file re-checks) — that is a pass, not a mismatch.
 */
export const requireAccessBinding: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth')
  const accessEmail = c.get('accessEmail')
  if (accessEmail === ACCESS_BYPASSED) {
    return next()
  }
  if (!auth.userId || !accessEmail) {
    return c.json({ error: 'FORBIDDEN', message: 'Access identity does not match the signed-in account' }, 403)
  }
  const row = await c.env.DB.prepare('SELECT email FROM users WHERE id = ? LIMIT 1').bind(auth.userId).first<{ email: string }>()
  if (!row || row.email.toLowerCase() !== accessEmail) {
    return c.json({ error: 'FORBIDDEN', message: 'Access identity does not match the signed-in account' }, 403)
  }
  return next()
}
