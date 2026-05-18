import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { encryptSecret, decryptSecret } from '../crypto/envelope'
import { createPrefixedId } from '../lib/auth'
import { requireAuth, secretReadRateLimit, secretWriteRateLimit } from '../middleware/auth'
import { assertSecretSize, getRequestIp, writeAuditLog } from '../lib/security'

export const secretRoutes = new Hono<{ Bindings: Env }>()

secretRoutes.use('*', requireAuth)

const secretSchema = z.object({
  projectId: z.string().min(1),
  envId: z.string().min(1),
  name: z.string().min(1).max(128),
  value: z.string().max(65536).optional(),
  isComputed: z.boolean().optional(),
  template: z.string().max(65536).optional(),
})

const createSecretSchema = secretSchema.refine((value) => value.value !== undefined || value.template !== undefined, {
  message: 'Either value or template is required',
})

const updateSecretSchema = secretSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
})

// GET /api/secrets?envId=xxx — list secrets (names only, no values)
secretRoutes.get('/', secretReadRateLimit, async (c) => {
  const auth = c.get('auth')
  const envId = c.req.query('envId')
  const projectId = c.req.query('projectId')

  if (!envId && !projectId) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'envId or projectId is required' }, 400)
  }

  const rows = await c.env.DB.prepare(
    'SELECT s.id, s.project_id, s.env_id, s.name, s.is_computed, s.template, s.created_at, s.updated_at FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id = ? AND (? IS NULL OR s.env_id = ?) AND (? IS NULL OR s.project_id = ?) ORDER BY s.created_at DESC',
  ).bind(auth.orgId, envId ?? null, envId ?? null, projectId ?? null, projectId ?? null).all()

  return c.json({ data: rows.results ?? [] })
})

// GET /api/secrets/:name — get and decrypt a single secret
secretRoutes.get('/:name', secretReadRateLimit, async (c) => {
  const auth = c.get('auth')
  const name = c.req.param('name')
  const envId = c.req.query('envId')

  if (!envId) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'envId is required' }, 400)
  }

  const secret = await c.env.DB.prepare(
    'SELECT s.id, s.project_id, s.env_id, s.name, s.wrapped_dek, s.is_computed, s.template, p.org_id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.name = ? AND s.env_id = ? AND p.org_id = ? LIMIT 1',
  ).bind(name, envId, auth.orgId).first<{ id: string; project_id: string; env_id: string; name: string; wrapped_dek: string; is_computed: number; template: string | null; org_id: string }>()

  if (!secret) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const encryptedValue = await c.env.SECRETS_KV.get(`secret:${secret.id}`)
  if (!encryptedValue) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret value not found' }, 404)
  }

  const value = await decryptSecret(encryptedValue, secret.wrapped_dek, c.env.ENCRYPTION_MASTER_KEY)
  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'secret.read',
    resourceType: 'secret',
    resourceId: secret.id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })
  return c.json({ data: { id: secret.id, name: secret.name, envId: secret.env_id, projectId: secret.project_id, value, isComputed: Boolean(secret.is_computed), template: secret.template } })
})

// POST /api/secrets — create a secret
secretRoutes.post('/', secretWriteRateLimit, zValidator('json', createSecretSchema), async (c) => {
  const auth = c.get('auth')
  const { projectId, envId, name, value, isComputed, template } = c.req.valid('json')

  if (value !== undefined) {
    assertSecretSize(value)
  }
  if (template !== undefined) {
    assertSecretSize(template)
  }

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? LIMIT 1').bind(projectId, auth.orgId).first<{ id: string }>()
  if (!project) {
    return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
  }

  const env = await c.env.DB.prepare('SELECT id FROM environments WHERE id = ? AND project_id = ? LIMIT 1').bind(envId, projectId).first<{ id: string }>()
  if (!env) {
    return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)
  }

  const secretId = createPrefixedId('sec')
  const secretValue = value ?? template ?? ''
  const { encryptedValue, wrappedDek } = await encryptSecret(secretValue, c.env.ENCRYPTION_MASTER_KEY)
  await c.env.SECRETS_KV.put(`secret:${secretId}`, encryptedValue)

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, is_computed, template, dependencies, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    secretId,
    projectId,
    envId,
    name,
    wrappedDek,
    'v1',
    Boolean(isComputed),
    template ?? null,
    '[]',
    now,
    now,
    auth.userId,
  ).run()

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'secret.create',
    resourceType: 'secret',
    resourceId: secretId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id: secretId, name, projectId, envId, isComputed: Boolean(isComputed), template: template ?? null } }, 201)
})

// PATCH /api/secrets/:id — update a secret value
secretRoutes.patch('/:id', secretWriteRateLimit, zValidator('json', updateSecretSchema), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const body = c.req.valid('json')
  const current = await c.env.DB.prepare(
    'SELECT s.id, s.project_id, s.env_id, s.name, s.is_computed, s.template, p.org_id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; project_id: string; env_id: string; name: string; is_computed: number; template: string | null; org_id: string }>()

  if (!current) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const nextName = body.name ?? current.name
  const nextIsComputed = body.isComputed ?? Boolean(current.is_computed)
  const nextTemplate = body.template ?? current.template
  const secretValue = body.value ?? nextTemplate ?? ''
  if (body.value !== undefined) {
    assertSecretSize(body.value)
  }
  if (nextTemplate != null) {
    assertSecretSize(nextTemplate)
  }
  const { encryptedValue, wrappedDek } = await encryptSecret(secretValue, c.env.ENCRYPTION_MASTER_KEY)

  await c.env.SECRETS_KV.put(`secret:${id}`, encryptedValue)
  await c.env.DB.prepare(
    'UPDATE secrets SET name = ?, wrapped_dek = ?, is_computed = ?, template = ?, updated_at = ? WHERE id = ?',
  ).bind(nextName, wrappedDek, nextIsComputed, nextTemplate ?? null, new Date().toISOString(), id).run()

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'secret.update',
    resourceType: 'secret',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id, name: nextName, isComputed: nextIsComputed, template: nextTemplate ?? null } })
})

// DELETE /api/secrets/:id — delete a secret
secretRoutes.delete('/:id', secretWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const secret = await c.env.DB.prepare(
    'SELECT s.id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string }>()

  if (!secret) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  await c.env.SECRETS_KV.delete(`secret:${id}`)
  await c.env.DB.prepare('DELETE FROM secrets WHERE id = ?').bind(id).run()

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'secret.delete',
    resourceType: 'secret',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { deleted: true } })
})
