import { Hono } from 'hono'
import type { Env } from '../index'

export const environmentRoutes = new Hono<{ Bindings: Env }>()

environmentRoutes.get('/', async (c) => c.json({ message: 'TODO: list environments' }, 501))
environmentRoutes.post('/', async (c) => c.json({ message: 'TODO: create environment' }, 501))

// GET /api/environments/:id/resolved — return secrets with branch inheritance applied
environmentRoutes.get('/:id/resolved', async (c) => {
  // TODO:
  // 1. Walk parentEnvId chain up to root
  // 2. Merge secrets: child overrides parent
  // 3. Return merged set (names only unless ?values=true)
  return c.json({ message: 'TODO: resolve inherited secrets' }, 501)
})
