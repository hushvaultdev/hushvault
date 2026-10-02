import { zValidator } from '@hono/zod-validator'
import { INTEGRATIONS } from '@hushvault/shared/integrations'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { encryptCredentialWithRing } from '../crypto/envelope'
import { getProvider, connectableProviderIds } from '../integrations/provider'
import { createPrefixedId } from '../lib/auth'
import { loadWriteRing } from '../lib/key-rotation'
import { getRequestIp, logKeyRingError, writeAuditLog } from '../lib/security'
import { integrationWriteRateLimit, requireAuth, requireHuman, requireRole } from '../middleware/auth'

// Outbound credential management (issue #39). Everything that creates, reads or changes a connection is
// human-only (API keys are refused), admin+, rate limited and audited. The credential goes in once and
// is never returned, logged or echoed in an error: responses carry metadata only.
export const integrationsRouter = new Hono<{ Bindings: Env }>()

integrationsRouter.use('*', requireAuth)

const MAX_CONNECTIONS_PER_ORG = 20

const createSchema = z.object({
  provider: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  credential: z.string().min(8).max(4096),
  config: z.record(z.unknown()).optional(),
})
const rotateSchema = z.object({ credential: z.string().min(8).max(4096) })

type ConnectionRow = {
  id: string
  provider: string
  label: string
  config_json: string
  created_at: string
  updated_at: string
  last_verified_at: string | null
}

// Never SELECT the ciphertext columns for a response.
const METADATA_COLUMNS = 'id, provider, label, config_json, created_at, updated_at, last_verified_at'

function metadata(row: ConnectionRow) {
  let config: unknown = {}
  try {
    config = JSON.parse(row.config_json)
  } catch {
    config = {}
  }
  return { id: row.id, provider: row.provider, label: row.label, config, createdAt: row.created_at, updatedAt: row.updated_at, lastVerifiedAt: row.last_verified_at }
}

const validationHook = (result: { success: boolean; error?: { issues: { message: string }[] } }, c: { json: (body: unknown, status: 400) => Response }) => {
  if (!result.success) {
    // Messages come from the schema, never from the submitted value.
    return c.json({ error: 'VALIDATION_ERROR', message: result.error?.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  return undefined
}

// GET /api/integrations/providers - what exists and how far along it is (any signed-in user)
integrationsRouter.get('/providers', (c) => {
  const connectable = new Set(connectableProviderIds())
  return c.json({
    data: INTEGRATIONS.map((i) => ({
      id: i.id, name: i.name, status: i.status, directions: i.directions, summary: i.summary, connectable: connectable.has(i.id),
    })),
  })
})

// POST /api/integrations/connections
integrationsRouter.post('/connections', requireHuman, requireRole('admin'), integrationWriteRateLimit, zValidator('json', createSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const body = c.req.valid('json')

  const provider = getProvider(body.provider)
  if (!provider) {
    return c.json({ error: 'UNSUPPORTED_PROVIDER', message: 'This integration is not available yet' }, 400)
  }
  const config = provider.parseConfig(body.config ?? {})
  if (!config) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid provider settings' }, 400)
  }

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM integration_connections WHERE org_id = ?').bind(auth.orgId).first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_CONNECTIONS_PER_ORG) {
    return c.json({ error: 'LIMIT_REACHED', message: 'This organisation has reached its connection limit' }, 409)
  }
  const clash = await c.env.DB.prepare('SELECT id FROM integration_connections WHERE org_id = ? AND provider = ? AND label = ? LIMIT 1').bind(auth.orgId, body.provider, body.label).first()
  if (clash) {
    return c.json({ error: 'CONFLICT', message: 'A connection with this label already exists' }, 409)
  }

  const verified = await verifyOpaque(provider.verify.bind(provider), body.credential, config)
  if (!verified.ok) return c.json({ error: verified.error, message: verified.message }, verified.status)

  const id = createPrefixedId('icn')
  let sealed
  try {
    sealed = await encryptCredentialWithRing(body.credential, await loadWriteRing(c.env), { orgId: auth.orgId, connectionId: id })
  } catch (err) {
    logKeyRingError(err)
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not store the credential' }, 500)
  }
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    'INSERT INTO integration_connections (id, org_id, provider, label, config_json, encrypted_credential, wrapped_dek, key_version, created_by, created_at, updated_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, auth.orgId, body.provider, body.label, JSON.stringify(config), sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, auth.userId, now, now, now).run()

  await audit(c, auth, 'integration.connect', id)
  return c.json({ data: metadata({ id, provider: body.provider, label: body.label, config_json: JSON.stringify(config), created_at: now, updated_at: now, last_verified_at: now }) }, 201)
})

// GET /api/integrations/connections
integrationsRouter.get('/connections', requireHuman, requireRole('admin'), async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(`SELECT ${METADATA_COLUMNS} FROM integration_connections WHERE org_id = ? ORDER BY created_at DESC`).bind(auth.orgId).all<ConnectionRow>()
  return c.json({ data: (rows.results ?? []).map(metadata) })
})

// PUT /api/integrations/connections/:id/credential - rotate the stored credential
integrationsRouter.put('/connections/:id/credential', requireHuman, requireRole('admin'), integrationWriteRateLimit, zValidator('json', rotateSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const { credential } = c.req.valid('json')

  const row = await c.env.DB.prepare('SELECT id, provider, config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1').bind(id, auth.orgId).first<{ id: string; provider: string; config_json: string }>()
  const provider = row ? getProvider(row.provider) : undefined
  if (!row || !provider) {
    return c.json({ error: 'NOT_FOUND', message: 'Connection not found' }, 404)
  }
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(row.config_json) as Record<string, unknown>
  } catch {
    config = {}
  }

  const verified = await verifyOpaque(provider.verify.bind(provider), credential, config)
  if (!verified.ok) return c.json({ error: verified.error, message: verified.message }, verified.status)

  let sealed
  try {
    sealed = await encryptCredentialWithRing(credential, await loadWriteRing(c.env), { orgId: auth.orgId, connectionId: id })
  } catch (err) {
    logKeyRingError(err)
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not store the credential' }, 500)
  }
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    'UPDATE integration_connections SET encrypted_credential = ?, wrapped_dek = ?, key_version = ?, updated_at = ?, last_verified_at = ? WHERE id = ? AND org_id = ?',
  ).bind(sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, now, now, id, auth.orgId).run()

  await audit(c, auth, 'integration.update', id)
  const updated = await c.env.DB.prepare(`SELECT ${METADATA_COLUMNS} FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1`).bind(id, auth.orgId).first<ConnectionRow>()
  return c.json({ data: updated ? metadata(updated) : null })
})

// DELETE /api/integrations/connections/:id - revoke: the credential and its wrapped key are deleted with the row
integrationsRouter.delete('/connections/:id', requireHuman, requireRole('admin'), integrationWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const result = await c.env.DB.prepare('DELETE FROM integration_connections WHERE id = ? AND org_id = ?').bind(id, auth.orgId).run()
  if (Number(result.meta.changes ?? 0) !== 1) {
    return c.json({ error: 'NOT_FOUND', message: 'Connection not found' }, 404)
  }
  await audit(c, auth, 'integration.revoke', id)
  return c.json({ data: { revoked: true } })
})

type Auth = { orgId: string; userId: string; actorType: 'user' | 'api_key' }

async function audit(c: { env: Env; req: { header: (n: string) => string | undefined } } & Parameters<typeof getRequestIp>[0], auth: Auth, action: string, resourceId: string) {
  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action,
    resourceType: 'integration_connection',
    resourceId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })
}

/** Run provider.verify and map every failure to a fixed, credential-free response. */
async function verifyOpaque(
  verify: (credential: string, config: Record<string, unknown>) => Promise<import('../integrations/provider').VerifyResult>,
  credential: string,
  config: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; message: string; status: 422 | 429 | 502 }> {
  try {
    const result = await verify(credential, config)
    if (result.ok) return { ok: true }
    if (result.code === 'PROVIDER_AUTH') return { ok: false, error: 'CREDENTIAL_REJECTED', message: 'The provider rejected this credential', status: 422 }
    if (result.code === 'PROVIDER_RATE_LIMIT') return { ok: false, error: 'PROVIDER_RATE_LIMIT', message: 'The provider is rate limiting requests; try again shortly', status: 429 }
    return { ok: false, error: 'PROVIDER_ERROR', message: 'Could not reach the provider', status: 502 }
  } catch {
    return { ok: false, error: 'PROVIDER_ERROR', message: 'Could not reach the provider', status: 502 }
  }
}
