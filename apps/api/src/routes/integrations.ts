import { zValidator } from '@hono/zod-validator'
import { INTEGRATIONS, type SyncErrorCode } from '@hushvault/shared/integrations'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { encryptCredentialWithRing } from '../crypto/envelope'
import { enqueueSyncForTarget } from '../integrations/sync-scheduler'
import { getProvider, connectableProviderIds } from '../integrations/provider'
import { isDeniedAccount, isTargetDenied } from '../integrations/target-denylist'
import { SyncEngineError, type SyncTargetRow, listSyncTargets, loadSyncRun, loadSyncTarget, newFingerprintSalt, previewSync, runSync, toSyncRunDto, toSyncTargetDto } from '../integrations/sync-engine'
import type { SyncTargetDto } from '@hushvault/shared/integrations'
import { isSyncProvider } from '../integrations/sync-types'
import { createPrefixedId } from '../lib/auth'
import { loadSyncLimits, maxSyncTargetsCaseSql } from '../lib/plan-limits'
import { loadWriteRing } from '../lib/key-rotation'
import { getRequestIp, logKeyRingError, writeAuditLog } from '../lib/security'
import { integrationPreviewRateLimit, integrationRunRateLimit, integrationWriteRateLimit, requireAuth, requireCurrentAdmin, requireHuman, requireRole } from '../middleware/auth'
import { validationHook } from '../lib/validation'

// Outbound credential management (issue #39). Everything that creates, reads or changes a connection is
// human-only (API keys are refused), admin+, rate limited and audited. The credential goes in once and
// is never returned, logged or echoed in an error: responses carry metadata only.
export const integrationsRouter = new Hono<{ Bindings: Env }>()

integrationsRouter.use('*', requireAuth)

const MAX_CONNECTIONS_PER_ORG = 20
const VERIFY_TIMEOUT_MS = 5000

const adminOnly = [requireHuman, requireRole('admin'), requireCurrentAdmin] as const

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
integrationsRouter.post('/connections', ...adminOnly, integrationWriteRateLimit, zValidator('json', createSchema, validationHook), async (c) => {
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
  if (isDeniedAccount(c.env, config['accountId'])) return c.json(deniedBody, 422)

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
  // The cap is enforced inside the INSERT, so concurrent requests cannot exceed it.
  let inserted
  try {
    inserted = await c.env.DB.prepare(
      'INSERT INTO integration_connections (id, org_id, provider, label, config_json, encrypted_credential, wrapped_dek, key_version, created_by, created_at, updated_at, last_verified_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM integration_connections WHERE org_id = ?) < ?',
    ).bind(id, auth.orgId, body.provider, body.label, JSON.stringify(config), sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, auth.userId, now, now, now, auth.orgId, MAX_CONNECTIONS_PER_ORG).run()
  } catch (err) {
    if (String(err instanceof Error ? err.message : err).includes('UNIQUE')) {
      return c.json({ error: 'CONFLICT', message: 'A connection with this label already exists' }, 409)
    }
    throw err
  }
  const stored = await c.env.DB.prepare('SELECT 1 AS ok FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1').bind(id, auth.orgId).first()
  if (!stored) {
    void inserted
    return c.json({ error: 'LIMIT_REACHED', message: 'This organisation has reached its connection limit' }, 409)
  }

  await audit(c, auth, 'integration.connect', id)
  return c.json({ data: metadata({ id, provider: body.provider, label: body.label, config_json: JSON.stringify(config), created_at: now, updated_at: now, last_verified_at: now }) }, 201)
})

// GET /api/integrations/connections
integrationsRouter.get('/connections', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(`SELECT ${METADATA_COLUMNS} FROM integration_connections WHERE org_id = ? ORDER BY created_at DESC`).bind(auth.orgId).all<ConnectionRow>()
  return c.json({ data: (rows.results ?? []).map(metadata) })
})

// PUT /api/integrations/connections/:id/credential - rotate the stored credential
integrationsRouter.put('/connections/:id/credential', ...adminOnly, integrationWriteRateLimit, zValidator('json', rotateSchema, validationHook), async (c) => {
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
  const written = await c.env.DB.prepare(
    'UPDATE integration_connections SET encrypted_credential = ?, wrapped_dek = ?, key_version = ?, updated_at = ?, last_verified_at = ? WHERE id = ? AND org_id = ?',
  ).bind(sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, now, now, id, auth.orgId).run()
  if (Number(written.meta.changes ?? 0) !== 1) {
    return c.json({ error: 'NOT_FOUND', message: 'Connection not found' }, 404)
  }

  // Recovery (issue #98): a rejected credential is the common reason a target is parked `needs_attention`, and
  // nothing retries a parked target by itself — so without this a credential fix leaves its targets stuck and
  // every change made meanwhile is dropped (the outbox only enqueues active targets). Flip this connection's
  // parked targets back to active and re-enqueue the on-change ones so they catch up; scheduled targets resume
  // on their schedule. A target parked for an unrelated reason simply re-parks on its next run (self-correcting).
  const parked = await c.env.DB.prepare(
    "SELECT id, sync_on_change FROM sync_targets WHERE connection_id = ? AND org_id = ? AND status = 'needs_attention' AND deleted_at IS NULL",
  ).bind(id, auth.orgId).all<{ id: string; sync_on_change: number }>()
  if ((parked.results ?? []).length > 0) {
    await c.env.DB.prepare(
      "UPDATE sync_targets SET status = 'active', updated_at = ? WHERE connection_id = ? AND org_id = ? AND status = 'needs_attention' AND deleted_at IS NULL",
    ).bind(now, id, auth.orgId).run()
    for (const t of parked.results ?? []) {
      if (t.sync_on_change === 1) await enqueueSyncForTarget(c.env, t.id)
    }
  }

  await audit(c, auth, 'integration.update', id)
  const updated = await c.env.DB.prepare(`SELECT ${METADATA_COLUMNS} FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1`).bind(id, auth.orgId).first<ConnectionRow>()
  return c.json({ data: updated ? metadata(updated) : null })
})

// DELETE /api/integrations/connections/:id - revoke: the credential and its wrapped key are deleted with the row
integrationsRouter.delete('/connections/:id', ...adminOnly, integrationWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  // Revoking cascades to the connection's sync targets (migration 0011): list them first so each removal is audited.
  const cascaded = await c.env.DB.prepare('SELECT id FROM sync_targets WHERE connection_id = ? AND org_id = ? AND deleted_at IS NULL').bind(id, auth.orgId).all<{ id: string }>()
  const result = await c.env.DB.prepare('DELETE FROM integration_connections WHERE id = ? AND org_id = ?').bind(id, auth.orgId).run()
  if (Number(result.meta.changes ?? 0) !== 1) {
    return c.json({ error: 'NOT_FOUND', message: 'Connection not found' }, 404)
  }
  for (const t of cascaded.results ?? []) await audit(c, auth, 'sync.target.delete', t.id, 'sync_target')
  await audit(c, auth, 'integration.revoke', id)
  return c.json({ data: { revoked: true } })
})

// ---------------------------------------------------------------------------------------------
// Sync targets and runs (issues #40, #41). Same guards as connections: human-only, admin+, current membership.
// Responses are DTOs: names, counts and ids. Never values, credentials or provider bodies.
// ---------------------------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const nameFilterSchema = z.object({
  prefix: z.string().max(64).regex(/^[A-Za-z0-9_]*$/, 'Prefix may only contain letters, digits and underscores').optional(),
  deny: z.array(z.string().max(128).regex(NAME, 'Invalid name in deny list')).max(200).optional(),
}).strict()

const autoSyncSchema = z.object({
  onChange: z.boolean().optional(),
  scheduleMinutes: z.union([z.literal(15), z.literal(60), z.literal(360), z.literal(1440), z.null()]).optional(),
}).strict()

const createTargetSchema = z.object({
  projectId: z.string().min(1).max(64),
  envId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64),
  resource: z.record(z.unknown()),
  nameFilter: nameFilterSchema.optional(),
  deleteRemoved: z.boolean().optional(),
  autoSync: autoSyncSchema.optional(),
}).strict()

const patchTargetSchema = z.object({
  resource: z.record(z.unknown()).optional(),
  nameFilter: nameFilterSchema.optional(),
  deleteRemoved: z.boolean().optional(),
  autoSync: autoSyncSchema.optional(),
}).strict()

function canonicalFilter(f: { prefix?: string; deny?: string[] }): string {
  return JSON.stringify({ prefix: f.prefix ?? '', deny: [...(f.deny ?? [])].sort() })
}

/** True when a run is queued or running with an unexpired lease (an expired lease is a crashed run). */
async function hasActiveRun(env: Env, targetId: string, nowIso: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS active FROM sync_runs WHERE target_id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until >= ?) LIMIT 1").bind(targetId, nowIso).first()
  return row !== null
}

function canonicalResource(resource: Record<string, string>): string {
  return JSON.stringify(Object.keys(resource).sort().map((k) => [k, resource[k]]))
}

/** Normalised filter: drop empty fields so equal filters compare equal. */
function cleanFilter(f: z.infer<typeof nameFilterSchema> | undefined): { prefix?: string; deny?: string[] } {
  const out: { prefix?: string; deny?: string[] } = {}
  if (f?.prefix) out.prefix = f.prefix
  if (f?.deny && f.deny.length > 0) out.deny = [...new Set(f.deny)]
  return out
}

type ConnRow = { id: string; provider: string; config_json: string }
type ResourceCheck = { ok: true; resource: Record<string, string> } | { ok: false; status: 400 | 409 | 422; error: string; message: string; existingId?: string }

/** Validate a resource for a connection: provider syntax, same account as the connection, denylist, no duplicate target. */
async function checkResource(env: Env, orgId: string, conn: ConnRow, raw: unknown, excludeTargetId?: string): Promise<ResourceCheck> {
  const provider = getProvider(conn.provider)
  if (!isSyncProvider(provider)) return { ok: false, status: 400, error: 'UNSUPPORTED_PROVIDER', message: 'This integration cannot be used as a sync target' }
  const resource = provider.parseResource(raw)
  if (!resource) return { ok: false, status: 400, error: 'VALIDATION_ERROR', message: 'Invalid target settings' }
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(conn.config_json) as Record<string, unknown> } catch { config = {} }
  if (config['accountId'] !== undefined && resource['accountId'] !== undefined && config['accountId'] !== resource['accountId']) {
    return { ok: false, status: 400, error: 'VALIDATION_ERROR', message: 'Target account does not match the connection' }
  }
  if (isTargetDenied(env, resource, config)) {
    return { ok: false, status: 422, error: 'TARGET_NOT_ALLOWED', message: 'This Worker cannot be used as a sync target' }
  }
  const same = await env.DB.prepare('SELECT id, resource_json FROM sync_targets WHERE org_id = ? AND connection_id = ? AND deleted_at IS NULL').bind(orgId, conn.id).all<{ id: string; resource_json: string }>()
  const wanted = canonicalResource(resource)
  for (const row of same.results ?? []) {
    if (row.id === excludeTargetId) continue
    try {
      if (canonicalResource(JSON.parse(row.resource_json) as Record<string, string>) === wanted) {
        return { ok: false, status: 409, error: 'CONFLICT', message: 'A sync target for this resource already exists', existingId: row.id }
      }
    } catch { /* an unparseable row cannot clash */ }
  }
  return { ok: true, resource }
}

const SYNC_ERROR_RESPONSES: Record<string, { status: 422 | 429 | 502; message: string }> = {
  PROVIDER_AUTH: { status: 422, message: 'The provider rejected the stored credential' },
  CREDENTIAL_UNAVAILABLE: { status: 422, message: 'The stored credential could not be used; rotate it' },
  COMPUTED_ERROR: { status: 422, message: 'The environment could not be resolved (check computed secrets)' },
  DECRYPTION_FAILED: { status: 422, message: 'The environment secrets could not be decrypted' },
  TARGET_NOT_ALLOWED: { status: 422, message: 'This Worker cannot be used as a sync target' },
  TARGET_NOT_FOUND: { status: 422, message: 'The provider could not find the target' },
  PROVIDER_RATE_LIMIT: { status: 429, message: 'The provider is rate limiting requests; try again shortly' },
  PROVIDER_VALIDATION: { status: 502, message: 'The provider rejected the request' },
  PROVIDER_ERROR: { status: 502, message: 'Could not reach the provider' },
  TIMEOUT: { status: 502, message: 'The provider timed out' },
}

function syncFailure(code: SyncErrorCode) {
  const mapped = SYNC_ERROR_RESPONSES[code] ?? { status: 502 as const, message: 'Could not reach the provider' }
  return { body: { error: code, message: mapped.message }, status: mapped.status }
}

const notFound = (what: string) => ({ error: 'NOT_FOUND', message: `${what} not found` })
const busyBody = { error: 'BUSY', message: 'A sync is queued or running for this target; change its settings after it finishes' }
const deniedBody = { error: 'TARGET_NOT_ALLOWED', message: 'This Worker cannot be used as a sync target' }

type CreateTargetSpec = z.infer<typeof createTargetSchema>
type CreateOutcome =
  | { kind: 'created'; target: SyncTargetRow }
  | { kind: 'existing'; target: SyncTargetRow }
  | { kind: 'plan_limit' }
  | { kind: 'error'; status: 400 | 404 | 409 | 422 | 500; error: string; message: string }

/**
 * Validate and create one sync target, shared by the single and bulk endpoints. Idempotent by (connection,
 * resource): an exact duplicate returns the EXISTING target (`existing`) rather than erroring, so re-running an
 * onboarding script is safe. The per-plan cap is enforced inside the INSERT (atomic under concurrency); hitting
 * it yields `plan_limit`. Does NOT audit — the caller audits each `created` so one bulk call writes one row per
 * new target.
 */
async function createOneTarget(env: Env, orgId: string, actorUserId: string, spec: CreateTargetSpec): Promise<CreateOutcome> {
  const conn = await env.DB.prepare('SELECT id, provider, config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1').bind(spec.connectionId, orgId).first<ConnRow>()
  if (!conn) return { kind: 'error', status: 404, error: 'NOT_FOUND', message: 'Connection not found' }
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? LIMIT 1').bind(spec.projectId, orgId).first()
  if (!project) return { kind: 'error', status: 404, error: 'NOT_FOUND', message: 'Project not found' }
  const environment = await env.DB.prepare('SELECT id FROM environments WHERE id = ? AND project_id = ? LIMIT 1').bind(spec.envId, spec.projectId).first()
  if (!environment) return { kind: 'error', status: 404, error: 'NOT_FOUND', message: 'Environment not found' }

  const checked = await checkResource(env, orgId, conn, spec.resource)
  if (!checked.ok) {
    // An exact-resource duplicate is idempotent, not an error: hand back the existing target.
    if (checked.status === 409 && checked.existingId) {
      const existing = await loadSyncTarget(env, checked.existingId, orgId)
      if (existing) return { kind: 'existing', target: existing }
    }
    return { kind: 'error', status: checked.status, error: checked.error, message: checked.message }
  }

  const id = createPrefixedId('ist')
  const now = new Date().toISOString()
  // The per-plan cap is enforced inside the INSERT, so concurrent requests (and bulk items) cannot exceed it.
  try {
    await env.DB.prepare(
      'INSERT INTO sync_targets (id, org_id, project_id, env_id, connection_id, provider, resource_json, name_filter_json, delete_removed, sync_on_change, schedule_minutes, fingerprint_salt, status, created_by, created_at, updated_at)'
      + ' SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', ?, ?, ?'
      + ' WHERE (SELECT COUNT(*) FROM sync_targets WHERE org_id = ? AND deleted_at IS NULL) < '
      + maxSyncTargetsCaseSql('SELECT plan FROM organisations WHERE id = ?'),
    ).bind(id, orgId, spec.projectId, spec.envId, conn.id, conn.provider, JSON.stringify(checked.resource), JSON.stringify(cleanFilter(spec.nameFilter)), spec.deleteRemoved ? 1 : 0, spec.autoSync?.onChange ? 1 : 0, spec.autoSync?.scheduleMinutes ?? null, newFingerprintSalt(), actorUserId, now, now, orgId, orgId).run()
  } catch {
    return { kind: 'error', status: 500, error: 'INTERNAL_ERROR', message: 'Could not create the sync target' }
  }
  const target = await loadSyncTarget(env, id, orgId)
  if (!target) return { kind: 'plan_limit' }
  return { kind: 'created', target }
}

// POST /api/integrations/targets
integrationsRouter.post('/targets', ...adminOnly, integrationWriteRateLimit, zValidator('json', createTargetSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const outcome = await createOneTarget(c.env, auth.orgId, auth.userId, c.req.valid('json'))
  if (outcome.kind === 'plan_limit') {
    const limits = await loadSyncLimits(c.env, auth.orgId)
    return c.json({ error: 'PLAN_LIMIT', message: `This plan allows ${limits.maxSyncTargets} sync targets; an operator can raise the organisation's plan to add more` }, 409)
  }
  // Single create keeps a 409 CONFLICT for an exact duplicate (the interactive signal); scripts use /targets/bulk,
  // which is idempotent.
  if (outcome.kind === 'existing') return c.json({ error: 'CONFLICT', message: 'A sync target for this resource already exists' }, 409)
  if (outcome.kind === 'error') return c.json({ error: outcome.error, message: outcome.message }, outcome.status)
  await audit(c, auth, 'sync.target.create', outcome.target.id, 'sync_target')
  return c.json({ data: await toSyncTargetDto(c.env, outcome.target) }, 201)
})

// POST /api/integrations/targets/bulk — create many targets in one call, idempotently (onboarding scripts).
// Per item: a new target is created, an exact (connection, resource) duplicate is returned as existing, and a
// validation/plan problem is reported in `errors` by index — the batch never half-fails the request.
const BULK_MAX_TARGETS = 50
const bulkTargetSchema = z.object({ targets: z.array(createTargetSchema).min(1).max(BULK_MAX_TARGETS) }).strict()
integrationsRouter.post('/targets/bulk', ...adminOnly, integrationWriteRateLimit, zValidator('json', bulkTargetSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { targets } = c.req.valid('json')
  const created: SyncTargetDto[] = []
  const existing: SyncTargetDto[] = []
  const errors: { index: number; error: string; message: string }[] = []
  for (let i = 0; i < targets.length; i += 1) {
    const outcome = await createOneTarget(c.env, auth.orgId, auth.userId, targets[i]!)
    if (outcome.kind === 'created') {
      await audit(c, auth, 'sync.target.create', outcome.target.id, 'sync_target')
      created.push(await toSyncTargetDto(c.env, outcome.target))
    } else if (outcome.kind === 'existing') {
      existing.push(await toSyncTargetDto(c.env, outcome.target))
    } else if (outcome.kind === 'plan_limit') {
      const limits = await loadSyncLimits(c.env, auth.orgId)
      errors.push({ index: i, error: 'PLAN_LIMIT', message: `This plan allows ${limits.maxSyncTargets} sync targets; an operator can raise the organisation's plan to add more` })
    } else {
      errors.push({ index: i, error: outcome.error, message: outcome.message })
    }
  }
  return c.json({ data: { created, existing, errors } }, 201)
})

// GET /api/integrations/coverage — environments in the org that have no active sync target yet.
// Lets a multi-repo client audit onboarding ("which environments aren't mapped?") without paging every target.
integrationsRouter.get('/coverage', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    'SELECT e.id AS env_id, e.name AS env_name, e.slug AS env_slug, p.id AS project_id, p.name AS project_name'
    + ' FROM environments e INNER JOIN projects p ON p.id = e.project_id AND p.org_id = ?'
    + ' WHERE NOT EXISTS (SELECT 1 FROM sync_targets t WHERE t.env_id = e.id AND t.org_id = ? AND t.deleted_at IS NULL)'
    + ' ORDER BY p.name, e.name LIMIT 500',
  ).bind(auth.orgId, auth.orgId).all<{ env_id: string; env_name: string; env_slug: string; project_id: string; project_name: string }>()
  const environmentsWithoutTarget = (rows.results ?? []).map((r) => ({
    envId: r.env_id, envName: r.env_name, envSlug: r.env_slug, projectId: r.project_id, projectName: r.project_name,
  }))
  return c.json({ data: { environmentsWithoutTarget } })
})

// GET /api/integrations/targets?limit=&cursor=
// Keyset-paginated, newest first; each target's last run status resolves in the same query (no N+1).
integrationsRouter.get('/targets', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined
  const { targets, nextCursor } = await listSyncTargets(c.env, auth.orgId, { limit, cursor: c.req.query('cursor') ?? null })
  return c.json({ data: targets, nextCursor })
})

// PATCH /api/integrations/targets/:id - the connection cannot be changed
integrationsRouter.patch('/targets/:id', ...adminOnly, integrationWriteRateLimit, zValidator('json', patchTargetSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const body = c.req.valid('json')
  const target = await loadSyncTarget(c.env, id, auth.orgId)
  if (!target) return c.json(notFound('Sync target'), 404)

  let resource = target.resource
  let resourceChanged = false
  if (body.resource !== undefined) {
    const conn = await c.env.DB.prepare('SELECT id, provider, config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1').bind(target.connectionId, auth.orgId).first<ConnRow>()
    if (!conn) return c.json(notFound('Connection'), 404)
    const checked = await checkResource(c.env, auth.orgId, conn, body.resource, target.id)
    if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, checked.status)
    resource = checked.resource
    resourceChanged = canonicalResource(resource) !== canonicalResource(target.resource)
  }
  const nameFilter = body.nameFilter !== undefined ? cleanFilter(body.nameFilter) : target.nameFilter
  const deleteRemoved = body.deleteRemoved ?? target.deleteRemoved
  const autoSync = {
    onChange: body.autoSync?.onChange ?? target.autoSync.onChange,
    scheduleMinutes: body.autoSync?.scheduleMinutes !== undefined ? body.autoSync.scheduleMinutes : target.autoSync.scheduleMinutes,
  }
  const filterChanged = canonicalFilter(nameFilter) !== canonicalFilter(target.nameFilter)
  // Changing what is synced (resource or filter) while a run is queued or running would let that run act on the
  // old settings: refuse. The UPDATE below repeats the check atomically for the race between check and write.
  const structural = resourceChanged || filterChanged
  const now = new Date().toISOString()
  if (structural && await hasActiveRun(c.env, id, now)) return c.json(busyBody, 409)
  const noActiveRun = "(? = 0 OR NOT EXISTS (SELECT 1 FROM sync_runs WHERE target_id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until >= ?)))"
  const statements = [
    c.env.DB.prepare(`UPDATE sync_targets SET resource_json = ?, name_filter_json = ?, delete_removed = ?, sync_on_change = ?, schedule_minutes = ?, status = CASE WHEN ? = 1 THEN 'active' ELSE status END, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND ${noActiveRun}`)
      .bind(JSON.stringify(resource), JSON.stringify(nameFilter), deleteRemoved ? 1 : 0, autoSync.onChange ? 1 : 0, autoSync.scheduleMinutes, resourceChanged ? 1 : 0, now, id, auth.orgId, structural ? 1 : 0, id, now),
  ]
  // The ledger describes names HushVault wrote to the OLD resource. On a new resource it must not authorise deletes.
  if (resourceChanged) {
    statements.push(c.env.DB.prepare(`DELETE FROM sync_items WHERE target_id = ? AND ${noActiveRun}`).bind(id, 1, id, now))
  }
  const written = await c.env.DB.batch(statements)
  if (structural && Number(written[0]?.meta?.changes ?? 0) === 0) return c.json(busyBody, 409)

  await audit(c, auth, 'sync.target.update', id, 'sync_target')
  const updated = await loadSyncTarget(c.env, id, auth.orgId)
  if (!updated) return c.json(notFound('Sync target'), 404)
  // A re-activated on-change target missed any changes made while it needed attention: catch up.
  if (resourceChanged && updated.autoSync.onChange && updated.status === 'active') await enqueueSyncForTarget(c.env, id)
  return c.json({ data: await toSyncTargetDto(c.env, updated) })
})

// DELETE /api/integrations/targets/:id - soft delete; nothing is removed from the provider
integrationsRouter.delete('/targets/:id', ...adminOnly, integrationWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const now = new Date().toISOString()
  const result = await c.env.DB.prepare('UPDATE sync_targets SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL').bind(now, now, id, auth.orgId).run()
  if (Number(result.meta.changes ?? 0) !== 1) return c.json(notFound('Sync target'), 404)
  // A deleted target must not be retried: drop any scheduled retry of its runs.
  await c.env.DB.prepare('UPDATE sync_runs SET next_retry_at = NULL WHERE target_id = ? AND next_retry_at IS NOT NULL').bind(id).run()
  await audit(c, auth, 'sync.target.delete', id, 'sync_target')
  return c.json({ data: { deleted: true } })
})

/** Early denylist answer for the routes. The engine enforces the same rule again (and checks the connection's account). */
function targetDenied(env: Env, resource: Record<string, string>): boolean {
  return isTargetDenied(env, resource)
}

function requestMeta(c: Parameters<typeof getRequestIp>[0] & { req: { header: (n: string) => string | undefined } }) {
  return { ip: getRequestIp(c), userAgent: c.req.header('user-agent') ?? null }
}

// POST /api/integrations/targets/:id/preview - names only
integrationsRouter.post('/targets/:id/preview', ...adminOnly, integrationPreviewRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const target = await loadSyncTarget(c.env, id, auth.orgId)
  if (!target) return c.json(notFound('Sync target'), 404)
  if (targetDenied(c.env, target.resource)) return c.json(deniedBody, 422)
  try {
    const result = await previewSync(c.env, auth.orgId, id, { actorId: auth.userId, actorType: 'user', ...requestMeta(c) })
    if (!result.ok) {
      const failure = syncFailure(result.code)
      return c.json(failure.body, failure.status)
    }
    return c.json({ data: result.plan })
  } catch (err) {
    if (err instanceof SyncEngineError) {
      return err.code === 'NOT_FOUND' ? c.json(notFound('Sync target'), 404) : c.json({ error: 'PROVIDER_UNAVAILABLE', message: 'This integration is not available' }, 503)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not build the preview' }, 500)
  }
})

// POST /api/integrations/targets/:id/run
integrationsRouter.post('/targets/:id/run', ...adminOnly, integrationRunRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const target = await loadSyncTarget(c.env, id, auth.orgId)
  if (!target) return c.json(notFound('Sync target'), 404)
  if (targetDenied(c.env, target.resource)) return c.json(deniedBody, 422)
  try {
    // One plan only: runSync checks for an active run first, plans once, and hands a blocked plan back
    // (422 SYNC_BLOCKED with the plan) instead of recording a failed run.
    const run = await runSync(c.env, id, { trigger: 'manual', actorId: auth.userId, orgId: auth.orgId, returnBlocked: true, ...requestMeta(c) })
    if ('blocked' in run) {
      return c.json({ error: 'SYNC_BLOCKED', message: 'The plan has blockers; fix them before running', plan: run.blocked }, 422)
    }
    // A run that failed before anything was sent (resolution, credential, denylist or the provider's name list)
    // keeps the long-standing contract of a mapped HTTP error; it is recorded as a failed run as well. A failure
    // while pushing is a normal 200 with the failed run.
    const c0 = run.counts
    if (run.status === 'failed' && run.errorCode !== null && c0.failed === 0 && c0.created + c0.updated + c0.deleted === 0 && c0.skipped === 0) {
      const failure = syncFailure(run.errorCode)
      return c.json(failure.body, failure.status)
    }
    return c.json({ data: run })
  } catch (err) {
    if (err instanceof SyncEngineError) {
      if (err.code === 'NOT_FOUND') return c.json(notFound('Sync target'), 404)
      if (err.code === 'BUSY') return c.json({ error: 'BUSY', message: 'A sync is already running for this target' }, 409)
      return c.json({ error: 'PROVIDER_UNAVAILABLE', message: 'This integration is not available' }, 503)
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not run the sync' }, 500)
  }
})

// GET /api/integrations/targets/:id/runs - newest first, max 50
integrationsRouter.get('/targets/:id/runs', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const target = await loadSyncTarget(c.env, id, auth.orgId)
  if (!target) return c.json(notFound('Sync target'), 404)
  const rows = await c.env.DB.prepare(
    'SELECT id, target_id, trigger, status, attempt, counts_json, error_code, started_at, finished_at, next_retry_at FROM sync_runs WHERE target_id = ? ORDER BY started_at DESC, id DESC LIMIT 50',
  ).bind(id).all<Parameters<typeof toSyncRunDto>[0]>()
  return c.json({ data: (rows.results ?? []).map(toSyncRunDto) })
})

// GET /api/integrations/runs/:runId
integrationsRouter.get('/runs/:runId', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const run = await loadSyncRun(c.env, auth.orgId, c.req.param('runId'))
  if (!run) return c.json(notFound('Run'), 404)
  return c.json({ data: run })
})

type Auth = { orgId: string; userId: string; actorType: 'user' | 'api_key' | 'system' }

async function audit(c: { env: Env; req: { header: (n: string) => string | undefined } } & Parameters<typeof getRequestIp>[0], auth: Auth, action: string, resourceId: string, resourceType = 'integration_connection') {
  // The change is already committed: a failed audit write must not turn it into a 500 the client retries.
  try {
    await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action,
    resourceType,
    resourceId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
    })
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'integration.audit_failed', action }))
  }
}

/** Run provider.verify and map every failure to a fixed, credential-free response. */
async function verifyOpaque(
  verify: (credential: string, config: Record<string, unknown>, signal: AbortSignal) => Promise<import('../integrations/provider').VerifyResult>,
  credential: string,
  config: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; message: string; status: 422 | 429 | 502 }> {
  try {
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    const timeout = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))))
    const result = await Promise.race([verify(credential, config, signal), timeout])
    if (result.ok) return { ok: true }
    if (result.code === 'PROVIDER_AUTH') return { ok: false, error: 'CREDENTIAL_REJECTED', message: 'The provider rejected this credential', status: 422 }
    if (result.code === 'PROVIDER_RATE_LIMIT') return { ok: false, error: 'PROVIDER_RATE_LIMIT', message: 'The provider is rate limiting requests; try again shortly', status: 429 }
    return { ok: false, error: 'PROVIDER_ERROR', message: 'Could not reach the provider', status: 502 }
  } catch {
    return { ok: false, error: 'PROVIDER_ERROR', message: 'Could not reach the provider', status: 502 }
  }
}
