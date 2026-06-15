import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { requireAuth } from '../middleware/auth'

export const environmentRoutes = new Hono<{ Bindings: Env }>()

environmentRoutes.use('*', requireAuth)

const environmentSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(80).optional(),
  parentEnvId: z.string().min(1).optional(),
  color: z.string().max(24).optional(),
})

environmentRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const projectId = c.req.query('projectId')
  const environments = await c.env.DB.prepare(
    'SELECT e.id, e.project_id, e.name, e.slug, e.parent_env_id, e.color, e.created_at FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE p.org_id = ? AND (? IS NULL OR e.project_id = ?) ORDER BY e.created_at DESC',
  ).bind(auth.orgId, projectId ?? null, projectId ?? null).all()

  return c.json({ data: environments.results ?? [] })
})

environmentRoutes.post('/', zValidator('json', environmentSchema), async (c) => {
  const auth = c.get('auth')
  const { projectId, name, slug, parentEnvId, color } = c.req.valid('json')
  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? LIMIT 1').bind(projectId, auth.orgId).first<{ id: string }>()

  if (!project) {
    return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
  }

  if (parentEnvId) {
    const parent = await c.env.DB.prepare('SELECT id FROM environments WHERE id = ? AND project_id = ? LIMIT 1').bind(parentEnvId, projectId).first<{ id: string }>()
    if (!parent) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Parent environment not found' }, 400)
    }
  }

  const environmentId = createPrefixedId('env')
  const computedSlug = (slug ?? name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || environmentId.slice(-8)

  await c.env.DB.prepare(
    'INSERT INTO environments (id, project_id, name, slug, parent_env_id, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(environmentId, projectId, name, computedSlug, parentEnvId ?? null, color ?? '#6366f1', new Date().toISOString()).run()

  return c.json({ data: { id: environmentId, projectId, name, slug: computedSlug, parentEnvId: parentEnvId ?? null, color: color ?? '#6366f1' } }, 201)
})

// GET /api/environments/:id/resolved — return secrets with branch inheritance applied
environmentRoutes.get('/:id/resolved', async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const environment = await c.env.DB.prepare(
    'SELECT e.id, e.project_id, e.parent_env_id FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE e.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; project_id: string; parent_env_id: string | null }>()

  if (!environment) {
    return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)
  }

  const values = c.req.query('values') === 'true'
  const secrets = await c.env.DB.prepare(
    'SELECT id, name, is_computed, template FROM secrets WHERE env_id = ? ORDER BY created_at ASC',
  ).bind(environment.id).all<{ id: string; name: string; is_computed: number; template: string | null }>()

  return c.json({
    data: {
      environmentId: environment.id,
      values,
      secrets: (secrets.results ?? []).map((secret) => ({
        id: secret.id,
        name: secret.name,
        isComputed: Boolean(secret.is_computed),
        template: secret.template,
      })),
    },
  })
})
