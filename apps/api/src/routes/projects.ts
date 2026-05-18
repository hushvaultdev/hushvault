import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { requireAuth } from '../middleware/auth'

export const projectRoutes = new Hono<{ Bindings: Env }>()

projectRoutes.use('*', requireAuth)

const projectSchema = z.object({
	name: z.string().min(2).max(120),
	slug: z.string().min(2).max(80).optional(),
	description: z.string().max(500).optional(),
})

projectRoutes.get('/', async (c) => {
	const auth = c.get('auth')
	const projects = await c.env.DB.prepare('SELECT id, name, slug, description, created_at, updated_at FROM projects WHERE org_id = ? ORDER BY created_at DESC')
		.bind(auth.orgId)
		.all()

	return c.json({ data: projects.results ?? [] })
})

projectRoutes.post('/', zValidator('json', projectSchema), async (c) => {
	const auth = c.get('auth')
	const { name, slug, description } = c.req.valid('json')
	const projectId = createPrefixedId('prj')
	const now = new Date().toISOString()
	const computedSlug = (slug ?? name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || projectId.slice(-8)

	await c.env.DB.prepare(
		'INSERT INTO projects (id, org_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).bind(projectId, auth.orgId, name, computedSlug, description ?? null, now, now).run()

	return c.json({ data: { id: projectId, name, slug: computedSlug, description } }, 201)
})

projectRoutes.get('/:id', async (c) => {
	const auth = c.get('auth')
	const { id } = c.req.param()
	const project = await c.env.DB.prepare('SELECT id, name, slug, description, created_at, updated_at FROM projects WHERE id = ? AND org_id = ? LIMIT 1')
		.bind(id, auth.orgId)
		.first()

	if (!project) {
		return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
	}

	return c.json({ data: project })
})

projectRoutes.patch('/:id', zValidator('json', projectSchema.partial()), async (c) => {
	const auth = c.get('auth')
	const { id } = c.req.param()
	const body = c.req.valid('json')
	const current = await c.env.DB.prepare('SELECT id, name, slug, description FROM projects WHERE id = ? AND org_id = ? LIMIT 1')
		.bind(id, auth.orgId)
		.first<{ id: string; name: string; slug: string; description: string | null }>()

	if (!current) {
		return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
	}

	const nextName = body.name ?? current.name
	const nextSlug = (body.slug ?? current.slug).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
	await c.env.DB.prepare('UPDATE projects SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ? AND org_id = ?')
		.bind(nextName, nextSlug || current.slug, body.description ?? current.description, new Date().toISOString(), id, auth.orgId)
		.run()

	return c.json({ data: { ...current, name: nextName, slug: nextSlug || current.slug, description: body.description ?? current.description } })
})

projectRoutes.delete('/:id', async (c) => {
	const auth = c.get('auth')
	const { id } = c.req.param()
	const result = await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').bind(id, auth.orgId).run()

	if (!result.success || !result.meta.changes) {
		return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
	}

	return c.json({ data: { deleted: true } })
})
