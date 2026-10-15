// Resolves the signed-in user from a verified Cloudflare Access JWT email (issue #108 redesign).
// Replaces requireAuth + requireAccessBinding on /api/admin/* routes: the Access JWT (RS256,
// verified by requireAccessJwt) is the sole credential — no separate app login.
// Must run after requireAccessJwt, which sets accessEmail on the context.
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { ACCESS_BYPASSED } from './access-jwt'

export const requireAuthFromAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const accessEmail = c.get('accessEmail')

  let email: string
  if (accessEmail === ACCESS_BYPASSED) {
    const devEmail = c.env.DEV_ADMIN_EMAIL
    if (!devEmail) {
      return c.json({
        error: 'ACCESS_NOT_CONFIGURED',
        message: 'Set DEV_ADMIN_EMAIL in .dev.vars to use admin routes locally.',
      }, 503)
    }
    email = devEmail.toLowerCase()
  } else if (typeof accessEmail === 'string' && accessEmail.length > 0) {
    email = accessEmail
  } else {
    return c.json({ error: 'UNAUTHORIZED', message: 'Access verification required' }, 401)
  }

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1')
    .bind(email).first<{ id: string }>()
  if (!user) {
    return c.json({
      error: 'FORBIDDEN',
      message: 'No HushVault account found for this email. Sign up via the main app first.',
    }, 403)
  }

  c.set('auth', { userId: user.id, orgId: '', role: 'owner' as const, actorType: 'user' as const })
  return next()
}
