import { Hono } from 'hono'
import type { Env } from '../index'
import { requireAuth } from '../middleware/auth'

export const auditRoutes = new Hono<{ Bindings: Env }>()

auditRoutes.use('*', requireAuth)

auditRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    'SELECT id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, timestamp FROM audit_log WHERE org_id = ? ORDER BY timestamp DESC LIMIT 100',
  )
    .bind(auth.orgId)
    .all()

  return c.json({ data: rows.results ?? [] })
})
