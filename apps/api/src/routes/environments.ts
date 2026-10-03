import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { resolveEnvironment } from '../lib/resolve-environment'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { requireAuth, requireRole, secretReadRateLimit } from '../middleware/auth'
import { validationHook } from '../lib/validation'

export const environmentRoutes = new Hono<{ Bindings: Env }>()

environmentRoutes.use('*', requireAuth)

const environmentSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(80).optional(),
  parentEnvId: z.string().min(1).optional(),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex colour').optional(),
})

environmentRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const projectId = c.req.query('projectId')
  const environments = await c.env.DB.prepare(
    'SELECT e.id, e.project_id, e.name, e.slug, e.parent_env_id, e.color, e.created_at FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE p.org_id = ? AND (? IS NULL OR e.project_id = ?) ORDER BY e.created_at DESC',
  ).bind(auth.orgId, projectId ?? null, projectId ?? null).all()

  return c.json({ data: environments.results ?? [] })
})

environmentRoutes.post('/', requireRole('admin'), zValidator('json', environmentSchema, validationHook), async (c) => {
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

  const existing = await c.env.DB.prepare('SELECT id FROM environments WHERE project_id = ? AND slug = ? LIMIT 1').bind(projectId, computedSlug).first<{ id: string }>()
  if (existing) {
    return c.json({ error: 'CONFLICT', message: 'An environment with this slug already exists in the project' }, 409)
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO environments (id, project_id, name, slug, parent_env_id, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(environmentId, projectId, name, computedSlug, parentEnvId ?? null, color ?? '#6366f1', new Date().toISOString()).run()
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: 'CONFLICT', message: 'An environment with this slug already exists in the project' }, 409)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' }, 500)
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'environment.create',
    resourceType: 'environment',
    resourceId: environmentId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  })

  return c.json({ data: { id: environmentId, projectId, name, slug: computedSlug, parentEnvId: parentEnvId ?? null, color: color ?? '#6366f1' } }, 201)
})

// GET /api/environments/:id/resolved — secrets with branch inheritance applied (child overrides parent by name).
// The resolution itself lives in lib/resolve-environment.ts (shared with the sync engine).
environmentRoutes.get('/:id/resolved', secretReadRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const wantValues = c.req.query('values') === 'true'

  const result = await resolveEnvironment(c.env, auth.orgId, id, { values: wantValues })
  if (!result.ok) {
    switch (result.code) {
      case 'NOT_FOUND':
        return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)
      case 'INVALID_ENVIRONMENT_CHAIN':
        return c.json({ error: 'INVALID_ENVIRONMENT_CHAIN', message: result.message }, 422)
      case 'DECRYPTION_FAILED':
        return c.json({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' }, 500)
      case 'COMPUTED_ERROR':
        return c.json({ error: 'COMPUTED_SECRET_ERROR', message: result.message }, 422)
    }
  }

  if (wantValues) {
    await writeAuditLog(c.env, {
      orgId: auth.orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'secret.read_bulk',
      // A CI read is attributed to the rule that authorised it; a human read to the environment.
      resourceType: auth.scope ? 'oidc_repo_rule' : 'environment',
      resourceId: auth.scope ? auth.scope.ruleId : result.environmentId,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    })
  }

  return c.json({
    data: {
      environmentId: result.environmentId,
      values: wantValues,
      secrets: result.secrets,
    },
  })
})

