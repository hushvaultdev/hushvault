import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { decryptSecret } from '../crypto/envelope'
import { describeComputedError, evaluateSecrets } from '../lib/resolve'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { requireAuth, requireRole, secretReadRateLimit } from '../middleware/auth'

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

environmentRoutes.post('/', requireRole('admin'), zValidator('json', environmentSchema), async (c) => {
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

const MAX_INHERITANCE_DEPTH = 10

type SecretRow = { id: string; env_id: string; name: string; is_computed: number; template: string | null; wrapped_dek: string }

// GET /api/environments/:id/resolved — secrets with branch inheritance applied (child overrides parent by name)
environmentRoutes.get('/:id/resolved', secretReadRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const environment = await c.env.DB.prepare(
    'SELECT e.id, e.project_id, e.parent_env_id FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE e.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; project_id: string; parent_env_id: string | null }>()

  if (!environment) {
    return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)
  }

  const wantValues = c.req.query('values') === 'true'

  // Chain ordered root ... self. Every ancestor must be in the same project (hence same org).
  const chain: string[] = [environment.id]
  const seen = new Set<string>(chain)
  let parentId = environment.parent_env_id
  while (parentId) {
    if (seen.has(parentId) || chain.length > MAX_INHERITANCE_DEPTH) {
      return c.json({ error: 'INVALID_ENVIRONMENT_CHAIN', message: 'Environment inheritance chain is circular or too deep' }, 422)
    }
    const parent = await c.env.DB.prepare('SELECT id, parent_env_id FROM environments WHERE id = ? AND project_id = ? LIMIT 1')
      .bind(parentId, environment.project_id).first<{ id: string; parent_env_id: string | null }>()
    if (!parent) {
      return c.json({ error: 'INVALID_ENVIRONMENT_CHAIN', message: 'Parent environment is invalid' }, 422)
    }
    seen.add(parent.id)
    chain.unshift(parent.id)
    parentId = parent.parent_env_id
  }

  const rank = new Map(chain.map((envId, index) => [envId, index]))
  const rows = await c.env.DB.prepare(
    `SELECT id, env_id, name, is_computed, template, wrapped_dek FROM secrets WHERE project_id = ? AND env_id IN (${chain.map(() => '?').join(',')})`,
  ).bind(environment.project_id, ...chain).all<SecretRow>()

  // Later (closer to the requested env) rank wins.
  const merged = new Map<string, SecretRow>()
  for (const row of [...(rows.results ?? [])].sort((a, b) => (rank.get(a.env_id) ?? 0) - (rank.get(b.env_id) ?? 0))) {
    merged.set(row.name, row)
  }
  const selected = [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const plain = new Map<string, string>()
  if (wantValues) {
    try {
      for (const row of selected) {
        if (row.is_computed) continue
        const blob = await c.env.SECRETS_KV.get(`secret:${row.id}`)
        if (blob === null) throw new Error('missing blob')
        plain.set(row.name, await decryptSecret(blob, row.wrapped_dek, c.env.ENCRYPTION_MASTER_KEY))
      }
    } catch {
      return c.json({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' }, 500)
    }
  }

  let evaluated: Map<string, string> | null = null
  if (wantValues) {
    const result = evaluateSecrets(selected.map((row) => ({
      name: row.name,
      isComputed: Boolean(row.is_computed),
      template: row.template,
      ...(row.is_computed ? {} : { value: plain.get(row.name) ?? '' }),
    })))
    if (!result.ok) {
      return c.json({ error: 'COMPUTED_SECRET_ERROR', message: describeComputedError(result.error) }, 422)
    }
    evaluated = result.values

    await writeAuditLog(c.env, {
      orgId: auth.orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'secret.read_bulk',
      resourceType: 'environment',
      resourceId: environment.id,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    })
  }

  return c.json({
    data: {
      environmentId: environment.id,
      values: wantValues,
      secrets: selected.map((row) => ({
        id: row.id,
        name: row.name,
        isComputed: Boolean(row.is_computed),
        template: row.template,
        inheritedFrom: row.env_id === environment.id ? null : row.env_id,
        ...(evaluated ? { value: evaluated.get(row.name) ?? '' } : {}),
      })),
    },
  })
})
