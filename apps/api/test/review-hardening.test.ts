import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedApiKey, seedEnvironment, seedProject, seedUser } from './helpers/env'

async function auditActions(env: ReturnType<typeof createTestEnv>, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT action FROM audit_log WHERE org_id = ? ORDER BY timestamp').bind(orgId).all<{ action: string }>()
  return (rows.results ?? []).map((r) => r.action)
}

// Shortening audit retention hides every older row from both read paths, so it is the one
// setting that can erase the trail of whatever it is meant to be watching.
describe('audit retention is not a silent kill switch', () => {
  it('refuses an API key even when its owner is an admin', async () => {
    const env = createTestEnv()
    const { userId, orgId } = await seedUser(env, { role: 'owner' })
    const { rawKey } = await seedApiKey(env, userId)

    const res = await call(env, 'PUT', '/api/audit/retention', { token: rawKey, json: { overrideDays: 1 } })
    expect(res.status).toBe(403)

    const row = await env.DB.prepare('SELECT audit_retention_days AS d FROM organisations WHERE id = ?').bind(orgId).first<{ d: number | null }>()
    expect(row?.d ?? null).toBeNull()
  })

  it('refuses a member', async () => {
    const env = createTestEnv()
    const { token } = await seedUser(env, { role: 'member' })
    expect((await call(env, 'PUT', '/api/audit/retention', { token, json: { overrideDays: 1 } })).status).toBe(403)
  })

  it('records the change, with the old and new value, when an admin does it', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'admin' })

    const res = await call(env, 'PUT', '/api/audit/retention', { token, json: { overrideDays: 1 } })
    expect(res.status).toBe(200)
    expect(await auditActions(env, orgId)).toContain('audit.retention.update')

    const row = await env.DB.prepare("SELECT resource_id AS r FROM audit_log WHERE org_id = ? AND action = 'audit.retention.update'")
      .bind(orgId).first<{ r: string }>()
    expect(row?.r).toBe('plan-default->1')
  })

  it('records a revert too, so restoring the window leaves a trace', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'admin' })
    await call(env, 'PUT', '/api/audit/retention', { token, json: { overrideDays: 1 } })
    await call(env, 'PUT', '/api/audit/retention', { token, json: { overrideDays: null } })

    const rows = await env.DB.prepare("SELECT resource_id AS r FROM audit_log WHERE org_id = ? AND action = 'audit.retention.update' ORDER BY id")
      .bind(orgId).all<{ r: string }>()
    expect((rows.results ?? []).map((x) => x.r)).toContain('1->plan-default')
  })
})

describe('REQUIRE_VERIFIED_EMAIL covers share links, not just API keys', () => {
  it('blocks share creation for an unverified account', async () => {
    const env = createTestEnv({ REQUIRE_VERIFIED_EMAIL: '1' })
    const { token } = await seedUser(env, { role: 'member', emailVerified: false })

    const keyRes = await call(env, 'POST', '/api/auth/api-keys', { token, json: { name: 'k' } })
    expect(keyRes.status).toBe(403)

    const shareRes = await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'CIPHERTEXT' } })
    expect(shareRes.status).toBe(403)
    expect(shareRes.body.error).toBe('EMAIL_NOT_VERIFIED')
  })

  it('still allows a verified account', async () => {
    const env = createTestEnv({ REQUIRE_VERIFIED_EMAIL: '1' })
    const { token } = await seedUser(env, { role: 'member', emailVerified: true })
    expect((await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'CIPHERTEXT' } })).status).toBe(201)
  })
})

describe('logout-all and API keys', () => {
  it('leaves machine credentials alone by default, and says so', async () => {
    const env = createTestEnv()
    const { userId, token } = await seedUser(env)
    const { rawKey } = await seedApiKey(env, userId)

    const res = await call(env, 'POST', '/api/auth/logout-all', { token })
    expect(res.status).toBe(200)
    expect(res.body.data.apiKeysRevoked).toBe(false)
    expect(res.body.data.apiKeysStillActive).toBe(1)
    expect((await call(env, 'GET', '/api/projects', { token: rawKey })).status).toBe(200)
  })

  it('revokes them when explicitly asked', async () => {
    const env = createTestEnv()
    const { userId, token } = await seedUser(env)
    const { rawKey } = await seedApiKey(env, userId)

    const res = await call(env, 'POST', '/api/auth/logout-all', { token, json: { revokeApiKeys: true } })
    expect(res.status).toBe(200)
    expect(res.body.data.apiKeysRevoked).toBe(true)
    expect(res.body.data.apiKeysStillActive).toBe(0)
    expect((await call(env, 'GET', '/api/projects', { token: rawKey })).status).toBe(401)
  })
})

// A credential that can mint credentials defeats leaked-key containment: the leak report names
// one key hash, and the attacker keeps the ones they minted from it.
describe('API keys cannot mint or delete API keys', () => {
  it('refuses to mint with an API key, and still allows a signed-in user', async () => {
    const env = createTestEnv()
    const { userId, token } = await seedUser(env)
    const { rawKey } = await seedApiKey(env, userId)

    const viaKey = await call(env, 'POST', '/api/auth/api-keys', { token: rawKey, json: { name: 'minted' } })
    expect(viaKey.status).toBe(403)

    const viaUser = await call(env, 'POST', '/api/auth/api-keys', { token, json: { name: 'legitimate' } })
    expect(viaUser.status).toBe(201)

    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').bind(userId).first<{ n: number }>()
    expect(live?.n).toBe(2)
  })

  it('refuses to delete another key with an API key', async () => {
    const env = createTestEnv()
    const { userId } = await seedUser(env)
    const { rawKey } = await seedApiKey(env, userId)
    const victim = await seedApiKey(env, userId)

    expect((await call(env, 'DELETE', `/api/auth/api-keys/${victim.id}`, { token: rawKey })).status).toBe(403)
    const still = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = ?').bind(victim.id).first<{ n: number }>()
    expect(still?.n).toBe(1)
  })
})

// The audit trail holds every member's IP, user agent and secret-read history.
describe('audit reads are admin-only', () => {
  it('refuses a viewer and a member, allows an admin', async () => {
    const env = createTestEnv()
    const owner = await seedUser(env, { role: 'owner' })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const member = await seedUser(env, { role: 'member', orgId: owner.orgId })

    expect((await call(env, 'GET', '/api/audit', { token: viewer.token })).status).toBe(403)
    expect((await call(env, 'GET', '/api/audit', { token: member.token })).status).toBe(403)
    expect((await call(env, 'GET', '/api/audit', { token: owner.token })).status).toBe(200)
  })

  it('refuses a viewer-scoped API key', async () => {
    const env = createTestEnv()
    const viewer = await seedUser(env, { role: 'viewer' })
    const { rawKey } = await seedApiKey(env, viewer.userId)
    expect((await call(env, 'GET', '/api/audit', { token: rawKey })).status).toBe(403)
    expect((await call(env, 'GET', '/api/audit/export', { token: rawKey })).status).toBe(403)
  })
})

// The rotation status endpoint answers one question: is it safe to retire the old key? A
// `completed` job was never a sufficient answer on its own.
describe('key-rotation status reports what blocks key retirement', () => {
  it('flags rows still on the pre-AAD blob format', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'admin' })
    const projectId = await seedProject(env, orgId)
    const envId = await seedEnvironment(env, projectId)
    await call(env, 'POST', '/api/secrets', { token, json: { projectId, envId, name: 'A', value: 'v' } })

    const clean = await call(env, 'GET', '/api/security/key-rotation', { token })
    expect(clean.status).toBe(200)
    expect(clean.body.data.legacyEncVersionRows).toBe(0)

    // A migration-era row: rotation advances its key_version but never its enc_version.
    await env.DB.prepare('UPDATE secrets SET enc_version = 1').run()
    const legacy = await call(env, 'GET', '/api/security/key-rotation', { token })
    expect(legacy.body.data.legacyEncVersionRows).toBe(1)
  })

  it('refuses to call retirement safe while rows are quarantined', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'admin' })
    const projectId = await seedProject(env, orgId)
    const envId = await seedEnvironment(env, projectId)
    await call(env, 'POST', '/api/secrets', { token, json: { projectId, envId, name: 'A', value: 'v' } })

    const now = new Date().toISOString()
    await env.DB.prepare("INSERT INTO encryption_keys (version, status, check_value, created_at) VALUES ('v1', 'active', 'x', ?)").bind(now).run()
    await env.DB.prepare(
      "INSERT INTO key_rotations (id, from_version, to_version, status, phase, started_at, updated_at) VALUES ('rot_1', 'v1', 'v2', 'completed', 'connections', ?, ?)",
    ).bind(now, now).run()

    const before = await call(env, 'GET', '/api/security/key-rotation', { token })
    expect(before.body.data.unresolvedRows).toBe(0)

    await env.DB.prepare(
      "INSERT INTO key_rotation_failures (rotation_id, table_name, row_id, error_code) VALUES ('rot_1', 'secrets', 'sec_x', 'UNWRAP_FAILED')",
    ).run()

    const after = await call(env, 'GET', '/api/security/key-rotation', { token })
    expect(after.body.data.unresolvedRows).toBe(1)
    expect(after.body.data.failureCodes).toEqual(['UNWRAP_FAILED'])
    expect(after.body.data.safeToRetireOldKeys).toBe(false)
  })
})
