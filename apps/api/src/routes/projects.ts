import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { requireAuth, requireRole } from '../middleware/auth'
import { KV_DELETE_CHUNK, allSecretBlobKeys, historyBlobKey } from '../lib/secret-blobs'
import { validationHook } from '../lib/validation'

export const projectRoutes = new Hono<{ Bindings: Env }>()

projectRoutes.use('*', requireAuth)

const createSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional(),
})

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
})


// Single place that turns user input into a URL-safe slug. Returns '' if nothing usable remains.
function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

const slugConflict = { error: 'CONFLICT', message: 'A project with this slug already exists' } as const

async function slugTaken(env: Env, orgId: string, slug: string, excludeId?: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM projects WHERE org_id = ? AND slug = ? AND id != ? LIMIT 1')
    .bind(orgId, slug, excludeId ?? '')
    .first()
  return row !== null
}

projectRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const projects = await c.env.DB.prepare('SELECT id, name, slug, description, created_at, updated_at FROM projects WHERE org_id = ? ORDER BY created_at DESC')
    .bind(auth.orgId)
    .all()

  return c.json({ data: projects.results ?? [] })
})

projectRoutes.post('/', requireRole('admin'), zValidator('json', createSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { name, slug, description } = c.req.valid('json')
  const projectId = createPrefixedId('prj')
  const now = new Date().toISOString()
  const computedSlug = toSlug(slug ?? name) || projectId.slice(-8).toLowerCase()

  if (await slugTaken(c.env, auth.orgId, computedSlug)) {
    return c.json(slugConflict, 409)
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO projects (id, org_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(projectId, auth.orgId, name, computedSlug, description ?? null, now, now).run()
  } catch (err) {
    if (isUniqueViolation(err)) return c.json(slugConflict, 409)
    throw err
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'project.create',
    resourceType: 'project',
    resourceId: projectId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id: projectId, name, slug: computedSlug, description: description ?? null } }, 201)
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

projectRoutes.patch('/:id', requireRole('admin'), zValidator('json', updateSchema, validationHook), async (c) => {
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
  const nextSlug = body.slug !== undefined ? (toSlug(body.slug) || current.slug) : current.slug
  // undefined = leave untouched, null = clear
  const nextDescription = body.description === undefined ? current.description : body.description

  if (nextSlug !== current.slug && (await slugTaken(c.env, auth.orgId, nextSlug, id))) {
    return c.json(slugConflict, 409)
  }

  try {
    await c.env.DB.prepare('UPDATE projects SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(nextName, nextSlug, nextDescription, new Date().toISOString(), id, auth.orgId)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return c.json(slugConflict, 409)
    throw err
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'project.update',
    resourceType: 'project',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id, name: nextName, slug: nextSlug, description: nextDescription } })
})

projectRoutes.delete('/:id', requireRole('admin'), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(id, auth.orgId)
    .first()
  if (!project) {
    return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
  }

  // Collect KV blob keys BEFORE the D1 cascade removes the rows that reference them.
  const secretRows = await c.env.DB.prepare('SELECT id, blob_rev FROM secrets WHERE project_id = ?')
    .bind(id).all<{ id: string; blob_rev: number }>()
  const historyRows = await c.env.DB.prepare(
    'SELECT h.id AS id, h.secret_id AS secret_id, h.blob_rev AS blob_rev FROM secret_history h JOIN secrets s ON s.id = h.secret_id WHERE s.project_id = ?',
  ).bind(id).all<{ id: string; secret_id: string; blob_rev: number | null }>()
  // Every revision of every value, deduplicated: a history row written since migration 0014
  // points at one of the secret's own revisions rather than a copy of its own.
  const kvKeySet = new Set<string>()
  for (const r of secretRows.results ?? []) {
    for (const key of allSecretBlobKeys(r.id, r.blob_rev)) kvKeySet.add(key)
  }
  for (const r of historyRows.results ?? []) kvKeySet.add(historyBlobKey(r.secret_id, r.id, r.blob_rev))
  const kvKeys = [...kvKeySet]

  // D1 first: data must never be gone from KV while still present in D1.
  const result = await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').bind(id, auth.orgId).run()
  if (!result.success || !result.meta.changes) {
    return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
  }

  // Best-effort blob cleanup; individual failures must not fail the request.
  for (let i = 0; i < kvKeys.length; i += KV_DELETE_CHUNK) {
    await Promise.all(
      kvKeys.slice(i, i + KV_DELETE_CHUNK).map(async (key) => {
        try {
          await c.env.SECRETS_KV.delete(key)
        } catch {
          // orphaned blob is unreachable (no D1 row / wrapped DEK); ignore
        }
      }),
    )
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'project.delete',
    resourceType: 'project',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { deleted: true } })
})
