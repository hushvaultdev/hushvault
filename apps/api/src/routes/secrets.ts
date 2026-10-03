import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { loadKeyRing, encryptSecretWithRing, decryptSecretWithRing } from '../crypto/envelope'
import { loadWriteRing } from '../lib/key-rotation'
import { createPrefixedId } from '../lib/auth'
import { enqueueSyncForEnvironment } from '../integrations/sync-scheduler'
import { requireAuth, requireRole, secretReadRateLimit, secretWriteRateLimit } from '../middleware/auth'
import { MAX_SECRET_VALUE_BYTES, getRequestIp, logKeyRingError, writeAuditLog } from '../lib/security'
import { KV_DELETE_CHUNK, allSecretBlobKeys, historyBlobKey, secretBlobKey } from '../lib/secret-blobs'
import { validationHook } from '../lib/validation'

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
    'SELECT s.id, s.project_id, s.env_id, s.name, s.wrapped_dek, s.key_version, s.enc_version, s.blob_rev, s.is_computed, s.template, p.org_id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.name = ? AND s.env_id = ? AND p.org_id = ? LIMIT 1',
  ).bind(name, envId, auth.orgId).first<{ id: string; project_id: string; env_id: string; name: string; wrapped_dek: string; key_version: string; enc_version: number; blob_rev: number; is_computed: number; template: string | null; org_id: string }>()

  if (!secret) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const encryptedValue = await c.env.SECRETS_KV.get(secretBlobKey(secret.id, secret.blob_rev))
  if (!encryptedValue) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret value not found' }, 404)
  }

  let value: string
  try {
    value = await decryptSecretWithRing(
      encryptedValue, secret.wrapped_dek, secret.key_version, loadKeyRing(c.env),
      { projectId: secret.project_id, envId: secret.env_id, secretId: secret.id }, secret.enc_version,
    )
  } catch (err) {
    logKeyRingError(err)
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
  const { encryptedValue, wrappedDek, keyVersion, encVersion } = await encryptSecretWithRing(
    secretValue, await loadWriteRing(c.env), { projectId, envId, secretId },
  )
  const blobRev = 1
  await c.env.SECRETS_KV.put(secretBlobKey(secretId, blobRev), encryptedValue)

  const now = new Date().toISOString()
  try {
    await c.env.DB.prepare(
      'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, enc_version, blob_rev, is_computed, template, dependencies, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      secretId,
      projectId,
      envId,
      name,
      wrappedDek,
      keyVersion,
      encVersion,
      blobRev,
      Boolean(isComputed),
      template ?? null,
      '[]',
      now,
      now,
      auth.userId,
    ).run()
  } catch (err) {
    // The id is a fresh nanoid, so this key can never be reused; a failed delete only leaks storage.
    await c.env.SECRETS_KV.delete(secretBlobKey(secretId, blobRev)).catch(() => undefined)
    if (isUniqueViolation(err)) {
      return conflict(c)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not create secret' }, 500)
  }

  await enqueueSyncForEnvironment(c.env, envId)
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
    'SELECT s.id, s.project_id, s.env_id, s.name, s.wrapped_dek, s.key_version, s.enc_version, s.blob_rev, s.is_computed, s.template, p.org_id FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; project_id: string; env_id: string; name: string; wrapped_dek: string; key_version: string; enc_version: number; blob_rev: number; is_computed: number; template: string | null; org_id: string }>()

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

  try {
    if (newPlaintext === undefined) {
      await c.env.DB.prepare(
        'UPDATE secrets SET name = ?, is_computed = ?, template = ?, updated_at = ? WHERE id = ?',
      ).bind(nextName, nextIsComputed, nextTemplate ?? null, now, id).run()
    } else {
      // Write-once blob, then move the pointer (migration 0014). The new ciphertext goes to
      // a KV key that has never existed, so nothing can be left disagreeing with D1: if the
      // D1 write below fails, the row still points at the previous revision, which still
      // matches the wrapped DEK it is stored with, and the secret stays readable. The orphan
      // is swept later. The previous code overwrote the live key first and tried to put the
      // old bytes back on failure — a second write to the same key in the same request, which
      // KV's one-write-per-second-per-key limit makes unreliable, so a failed update could
      // leave the secret permanently undecryptable (and with it the whole environment).
      const nextRev = current.blob_rev + 1
      const historyId = createPrefixedId('sech')
      const { encryptedValue, wrappedDek, keyVersion, encVersion } = await encryptSecretWithRing(
        newPlaintext, await loadWriteRing(c.env), { projectId: current.project_id, envId: current.env_id, secretId: id },
      )

      await c.env.SECRETS_KV.put(secretBlobKey(id, nextRev), encryptedValue)

      const update = c.env.DB.prepare(
        'UPDATE secrets SET name = ?, wrapped_dek = ?, key_version = ?, enc_version = ?, blob_rev = ?, is_computed = ?, template = ?, updated_at = ? WHERE id = ?',
      ).bind(nextName, wrappedDek, keyVersion, encVersion, nextRev, nextIsComputed, nextTemplate ?? null, now, id)
      // The history row points at the revision that already holds the old bytes rather than
      // copying them to a second key, so a value change costs one KV write instead of two.
      const history = c.env.DB.prepare(
        'INSERT INTO secret_history (id, secret_id, wrapped_dek, key_version, enc_version, blob_rev, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(historyId, id, current.wrapped_dek, current.key_version, current.enc_version, current.blob_rev, now, auth.userId)
      await c.env.DB.batch([history, update])
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return conflict(c)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not update secret' }, 500)
  }

  await enqueueSyncForEnvironment(c.env, current.env_id)
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
    'SELECT s.id, s.env_id, s.blob_rev FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(id, auth.orgId).first<{ id: string; env_id: string; blob_rev: number }>()

  if (!secret) {
    return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
  }

  const history = await c.env.DB.prepare('SELECT id, blob_rev FROM secret_history WHERE secret_id = ?')
    .bind(id).all<{ id: string; blob_rev: number | null }>()

  // Every revision of the value, plus the pre-0014 per-history copies. Collected before
  // the D1 delete, because afterwards there is nothing left to tell us which keys exist.
  const blobKeys = new Set(allSecretBlobKeys(id, secret.blob_rev))
  for (const row of history.results ?? []) blobKeys.add(historyBlobKey(id, row.id, row.blob_rev))

  // D1 first (history rows cascade); then remove blobs. Orphaned KV blobs are unreadable without their wrapped DEK.
  await c.env.DB.prepare('DELETE FROM secrets WHERE id = ?').bind(id).run()
  await enqueueSyncForEnvironment(c.env, secret.env_id)
  // Bounded concurrency: a secret with many revisions must not turn one delete into a
  // long serial chain of subrequests, and a single KV error must not 500 a request whose
  // D1 row is already gone (the leftovers are unreadable, so they cost storage, not safety).
  const keys = [...blobKeys]
  for (let i = 0; i < keys.length; i += KV_DELETE_CHUNK) {
    await Promise.all(keys.slice(i, i + KV_DELETE_CHUNK).map((k) => c.env.SECRETS_KV.delete(k).catch(() => undefined)))
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
