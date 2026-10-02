import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedApiKey, seedUser } from './helpers/env'

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
