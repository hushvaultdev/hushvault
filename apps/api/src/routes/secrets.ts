import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { encryptSecret, decryptSecret } from '../crypto/envelope'
import { createPrefixedId } from '../lib/auth'
import { requireAuth, requireRole, secretReadRateLimit, secretWriteRateLimit } from '../middleware/auth'
import { MAX_SECRET_VALUE_BYTES, getRequestIp, writeAuditLog } from '../lib/security'

export const secretRoutes = new Hono<{ Bindings: Env }>()

secretRoutes.use('*', requireAuth)

// Names become environment variable names downstream.
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const nameSchema = z.string().min(1).max(128).regex(SECRET_NAME_PATTERN, 'Name must match [A-Za-z_][A-Za-z0-9_]*')

const secretSchema = z.object({
  projectId: z.string().min(1),
  envId: z.string().min(1),
  name: nameSchema,
  value: z.string().optional(),
  isComputed: z.boolean().optional(),
  template: z.string().optional(),
})

const createSecretSchema = secretSchema.refine((value) => value.value !== undefined || value.template !== undefined, {
  message: 'Either value or template is required',
})

const updateSecretSchema = secretSchema.omit({ projectId: true, envId: true }).partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
})

const textEncoder = new TextEncoder()

function isTooLarge(value: string | undefined | null): boolean {
  return value != null && textEncoder.encode(value).byteLength > MAX_SECRET_VALUE_BYTES
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : ''
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT')
}

const validationHook = (result: { success: boolean; error?: { issues: { message: string }[] } }, c: { json: (body: unknown, status: 400) => Response }) => {
  if (!result.success) {
    return c.json({ error: 'VALIDATION_ERROR', message: result.error?.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  return undefined
}

function conflict(c: { json: (body: unknown, status: 409) => Response }) {
  return c.json({ error: 'CONFLICT', message: 'A secret with this name already exists in this environment' }, 409)
}

function sizeError(c: { json: (body: unknown, status: 400) => Response }) {
  return c.json({ error: 'VALIDATION_ERROR', message: 'Secret value exceeds 64KB limit' }, 400)
}

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

  let value: string
  try {
    value = await decryptSecret(encryptedValue, secret.wrapped_dek, c.env.ENCRYPTION_MASTER_KEY)
  } catch {
    return c.json({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' }, 500)
  }

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
secretRoutes.post('/', requireRole('member'), secretWriteRateLimit, zValidator('json', createSecretSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { projectId, envId, name, value, isComputed, template } = c.req.valid('json')

  if (isTooLarge(value) || isTooLarge(template)) {
    return sizeError(c)
  }

  const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? LIMIT 1').bind(projectId, auth.orgId).first<{ id: string }>()
  if (!project) {
    return c.json({ error: 'NOT_FOUND', message: 'Project not found' }, 404)
  }

  const env = await c.env.DB.prepare('SELECT id FROM environments WHERE id = ? AND project_id = ? LIMIT 1').bind(envId, projectId).first<{ id: string }>()
  if (!env) {
    return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)
  }

  const existing = await c.env.DB.prepare('SELECT id FROM secrets WHERE env_id = ? AND name = ? LIMIT 1').bind(envId, name).first<{ id: string }>()
  if (existing) {
    return conflict(c)
  }

  const secretId = createPrefixedId('sec')
  const secretValue = value ?? template ?? ''
  const { encryptedValue, wrappedDek } = await encryptSecret(secretValue, c.env.ENCRYPTION_MASTER_KEY)
  await c.env.SECRETS_KV.put(`secret:${secretId}`, encryptedValue)

  const now = new Date().toISOString()
  try {
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
  } catch (err) {
    await c.env.SECRETS_KV.delete(`secret:${secretId}`).catch(() => undefined)
    if (isUniqueViolation(err)) {
      return conflict(c)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not create secret' }, 500)
  }

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

// PATCH /api/secrets/:id — update a secret (rename, toggle computed, change value/template)
secretRoutes.patch('/:id', requireRole('member'), secretWriteRateLimit, zValidator('json', updateSecretSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const body = c.req.valid('json')

  if (isTooLarge(body.value) || isTooLarge(body.template)) {
    return sizeError(c)
  }

  const current = await c.env.DB.prepare(
    'SELECT s.id, s.project_id, s.env_id, s.name, s.wrapped_dek, s.key_version, s.is_computed, s.template, p.org_id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; project_id: string; env_id: string; name: string; wrapped_dek: string; key_version: string; is_computed: number; template: string | null; org_id: string }>()

  if (!current) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const nextName = body.name ?? current.name
  const nextIsComputed = body.isComputed ?? Boolean(current.is_computed)
  const nextTemplate = body.template !== undefined ? body.template : current.template

  // Only re-encrypt when new plaintext was actually supplied; a rename or flag change leaves the stored value untouched.
  const newPlaintext = body.value !== undefined
    ? body.value
    : (nextIsComputed && body.template !== undefined ? body.template : undefined)

  if (nextName !== current.name) {
    const clash = await c.env.DB.prepare('SELECT id FROM secrets WHERE env_id = ? AND name = ? AND id != ? LIMIT 1').bind(current.env_id, nextName, id).first<{ id: string }>()
    if (clash) {
      return conflict(c)
    }
  }

  const now = new Date().toISOString()
  const kvKey = `secret:${id}`

  try {
    if (newPlaintext === undefined) {
      await c.env.DB.prepare(
        'UPDATE secrets SET name = ?, is_computed = ?, template = ?, updated_at = ? WHERE id = ?',
      ).bind(nextName, nextIsComputed, nextTemplate ?? null, now, id).run()
    } else {
      const oldBlob = await c.env.SECRETS_KV.get(kvKey)
      const historyId = createPrefixedId('sech')
      const historyKey = `secrethist:${historyId}`
      const { encryptedValue, wrappedDek } = await encryptSecret(newPlaintext, c.env.ENCRYPTION_MASTER_KEY)

      if (oldBlob !== null) {
        await c.env.SECRETS_KV.put(historyKey, oldBlob)
      }
      try {
        await c.env.SECRETS_KV.put(kvKey, encryptedValue)
        const update = c.env.DB.prepare(
          'UPDATE secrets SET name = ?, wrapped_dek = ?, is_computed = ?, template = ?, updated_at = ? WHERE id = ?',
        ).bind(nextName, wrappedDek, nextIsComputed, nextTemplate ?? null, now, id)
        if (oldBlob !== null) {
          const history = c.env.DB.prepare(
            'INSERT INTO secret_history (id, secret_id, wrapped_dek, key_version, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
          ).bind(historyId, id, current.wrapped_dek, current.key_version, now, auth.userId)
          await c.env.DB.batch([history, update])
        } else {
          await update.run()
        }
      } catch (err) {
        // Best-effort rollback of KV so the old blob still matches the old wrapped DEK in D1.
        if (oldBlob !== null) {
          await c.env.SECRETS_KV.put(kvKey, oldBlob).catch(() => undefined)
          await c.env.SECRETS_KV.delete(historyKey).catch(() => undefined)
        }
        throw err
      }
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return conflict(c)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not update secret' }, 500)
  }

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
secretRoutes.delete('/:id', requireRole('member'), secretWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const secret = await c.env.DB.prepare(
    'SELECT s.id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string }>()

  if (!secret) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const history = await c.env.DB.prepare('SELECT id FROM secret_history WHERE secret_id = ?').bind(id).all<{ id: string }>()

  // D1 first (history rows cascade); then remove blobs. Orphaned KV blobs are unreadable without their wrapped DEK.
  await c.env.DB.prepare('DELETE FROM secrets WHERE id = ?').bind(id).run()
  await c.env.SECRETS_KV.delete(`secret:${id}`)
  for (const row of history.results ?? []) {
    await c.env.SECRETS_KV.delete(`secrethist:${row.id}`).catch(() => undefined)
  }

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
