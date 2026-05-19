import { Hono } from 'hono'
import type { Env } from '../index'

export const healthRoutes = new Hono<{ Bindings: Env }>()

healthRoutes.get('/', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first()
    return c.json({ status: 'ok', version: '0.0.1' })
  } catch {
    return c.json({ status: 'degraded', reason: 'database' }, 503)
  }
})
