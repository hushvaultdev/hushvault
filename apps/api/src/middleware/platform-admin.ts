// Platform-admin gate (issue #102/#103). Deliberately its own file, not folded into
// middleware/auth.ts: this is the highest-blast-radius surface in the API (it can change any
// tenant's plan), so it gets its own middleware that checks its own table, never `auth.role` (an
// org `owner` is not a platform admin — org membership grants nothing here).
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'

declare module 'hono' {
  interface ContextVariableMap {
    /** Present only after requirePlatformAdmin: the admin's own user id, for the audit actor. */
    platformAdminId: string
  }
}

/**
 * Must run after requireAuth. Re-reads `platform_admins` on every request — like
 * `requireCurrentAdmin`, never trusts a claim in the JWT — so revoking an admin takes effect
 * immediately, not after the token expires. A CI token (actorType 'system', empty userId) is
 * never a platform admin and is rejected before the query.
 */
export const requirePlatformAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth')
  if (!auth.userId) {
    return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
  }
  const row = await c.env.DB.prepare('SELECT 1 FROM platform_admins WHERE user_id = ? LIMIT 1').bind(auth.userId).first()
  if (!row) {
    return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
  }
  c.set('platformAdminId', auth.userId)
  return next()
}
