import { Hono } from 'hono'
import type { Env } from '../index'

export const projectRoutes = new Hono<{ Bindings: Env }>()

projectRoutes.get('/', async (c) => c.json({ message: 'TODO: list projects' }, 501))
projectRoutes.post('/', async (c) => c.json({ message: 'TODO: create project' }, 501))
projectRoutes.get('/:id', async (c) => c.json({ message: 'TODO: get project' }, 501))
projectRoutes.patch('/:id', async (c) => c.json({ message: 'TODO: update project' }, 501))
projectRoutes.delete('/:id', async (c) => c.json({ message: 'TODO: delete project' }, 501))
