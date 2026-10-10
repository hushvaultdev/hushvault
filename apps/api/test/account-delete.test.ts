// Account deletion / GDPR erasure (issue #81), DELETE /api/auth/account.
//
// The tests marked FALSIFICATION are the ones that define the issue. Each proves its guard by first
// reproducing the failure the guard exists to stop, or by asserting the exact thing that must NOT
// have happened:
//   * the FK fix: a user who created an integration_connection / sync_target / oidc_repo_rule is
//     blocked by `FOREIGN KEY constraint failed` on a bare `DELETE FROM users`, and is deletable
//     through the endpoint (which nulls created_by in the same batch);
//   * LAST_OWNER: the last owner of a SHARED org is refused, and the proof is that the user, the
//     org and its secrets all still exist afterwards — the refusal touched nothing;
//   * KV: a sole-member org's secret blob is gone from KV as well as D1, not just D1.
import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedApiKey, seedEnvironment, seedProject, seedUser, type Role, type TestEnv } from './helpers/env'
import { seedSecret } from './helpers/env-secrets'
import { seedConnection, seedTarget } from './helpers/sync-fixture'
import { createPrefixedId } from '../src/lib/auth'

const PASSWORD = 'correct horse battery staple'

async function seedOrg(env: TestEnv, name = 'Shared Org'): Promise<string> {
  const id = createPrefixedId('org')
  await env.DB.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-6).toLowerCase()}`, 'free', new Date().toISOString())
    .run()
  return id
}

async function addMembership(env: TestEnv, opts: { userId: string; orgId: string; role: Role }): Promise<void> {
  await env.DB.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(createPrefixedId('mem'), opts.orgId, opts.userId, opts.role, new Date(Date.now() + 60_000).toISOString())
    .run()
}

async function seedOidcRule(env: TestEnv, orgId: string, envId: string, createdBy: string): Promise<string> {
  const id = createPrefixedId('ocr')
  await env.DB.prepare(
    "INSERT INTO oidc_repo_rules (id, org_id, env_id, provider, repository, ref, created_by, created_at) VALUES (?, ?, ?, 'github', 'acme/app', 'refs/heads/main', ?, ?)",
  ).bind(id, orgId, envId, createdBy, new Date().toISOString()).run()
  return id
}

async function userExists(env: TestEnv, userId: string): Promise<boolean> {
  return (await env.DB.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').bind(userId).first()) !== null
}

describe('DELETE /api/auth/account — re-authentication', () => {
  it('refuses an API key (requireHuman), before touching anything', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })
    const key = await seedApiKey(env, user.userId)

    const res = await call(env, 'DELETE', '/api/auth/account', { token: key.rawKey, json: { password: PASSWORD } })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('FORBIDDEN')
    expect(await userExists(env, user.userId)).toBe(true)
  })

  it('a password account with no password in the body is refused before any delete', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })

    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: {} })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('REAUTH_REQUIRED')
    expect(await userExists(env, user.userId)).toBe(true)
  })

  it('a wrong password is refused before any delete', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })

    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: 'not the password' } })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('REAUTH_FAILED')
    expect(await userExists(env, user.userId)).toBe(true)
  })

  it('a correct password deletes the account', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })

    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: PASSWORD } })

    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
    expect(await userExists(env, user.userId)).toBe(false)
  })

  it('an OAuth-only account (no password) confirms by typing its email, not a password', async () => {
    const env = createTestEnv()
    const userId = createPrefixedId('usr')
    const orgId = createPrefixedId('org')
    const now = new Date().toISOString()
    // The OAuth signup shape: empty password_hash and salt.
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at, email_verified) VALUES (?, ?, '', '', 'github', 'gh-1', ?, 1)")
      .bind(userId, 'oauth@example.test', now).run()
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(orgId, 'O', `o-${orgId.slice(-6).toLowerCase()}`, 'free', now).run()
    await env.DB.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(createPrefixedId('mem'), orgId, userId, 'owner', now).run()
    const { signJwt } = await import('../src/lib/auth')
    const token = await signJwt({ sub: userId, orgId, role: 'owner' }, env.JWT_SECRET)

    // Wrong email: refused, nothing deleted.
    const wrong = await call(env, 'DELETE', '/api/auth/account', { token, json: { confirmEmail: 'someone@else.test' } })
    expect(wrong.status).toBe(403)
    expect(wrong.body.error).toBe('REAUTH_REQUIRED')
    expect(await userExists(env, userId)).toBe(true)

    // A password is not a valid confirmation for an OAuth-only account.
    const asPassword = await call(env, 'DELETE', '/api/auth/account', { token, json: { password: PASSWORD } })
    expect(asPassword.status).toBe(403)
    expect(await userExists(env, userId)).toBe(true)

    // Correct email (case-insensitive): deleted.
    const ok = await call(env, 'DELETE', '/api/auth/account', { token, json: { confirmEmail: 'OAuth@Example.Test' } })
    expect(ok.status).toBe(200)
    expect(await userExists(env, userId)).toBe(false)
  })
})

describe('DELETE /api/auth/account — the foreign-key fix (issue #81)', () => {
  it('FALSIFICATION: a bare DELETE FROM users is blocked, and the endpoint deletes the same user', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'admin', password: PASSWORD })
    const projectId = await seedProject(env, user.orgId)
    const envId = await seedEnvironment(env, projectId)
    // The three blocking REFERENCES users(id) columns, all owned by this user.
    const connectionId = await seedConnection(env, user.orgId, user.userId)
    await seedTarget(env, { orgId: user.orgId, projectId, envId, connectionId, userId: user.userId })
    await seedOidcRule(env, user.orgId, envId, user.userId)

    // Prove the guard is real: the bare delete fails on the FK (this is the issue).
    await expect(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.userId).run())
      .rejects.toThrow(/FOREIGN KEY constraint failed/i)
    expect(await userExists(env, user.userId)).toBe(true)

    // The endpoint nulls created_by in the same batch, so the delete succeeds.
    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)
    expect(await userExists(env, user.userId)).toBe(false)
  })

  it('a created_by in a SURVIVING shared org is nulled, and that row survives', async () => {
    const env = createTestEnv()
    // Two members, so the org is shared and survives. The departing user is not an owner.
    const owner = await seedUser(env, { role: 'owner' })
    const leaver = await seedUser(env, { role: 'member', orgId: owner.orgId, password: PASSWORD })
    const projectId = await seedProject(env, owner.orgId)
    const envId = await seedEnvironment(env, projectId)
    const ruleId = await seedOidcRule(env, owner.orgId, envId, leaver.userId)

    const res = await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)

    // The org and the rule survive; created_by is now NULL rather than a dangling id.
    const rule = await env.DB.prepare('SELECT created_by FROM oidc_repo_rules WHERE id = ? LIMIT 1')
      .bind(ruleId).first<{ created_by: string | null }>()
    expect(rule).not.toBeNull()
    expect(rule?.created_by).toBeNull()
  })
})

describe('DELETE /api/auth/account — organisations', () => {
  it('erases a sole-member org and its secrets from D1 AND KV', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })
    const projectId = await seedProject(env, user.orgId)
    const envId = await seedEnvironment(env, projectId)
    const secretId = await seedSecret(env, projectId, envId, 'DB_URL', 'postgres://secret')

    // The blob is really in KV to begin with.
    const blobKey = `secret:${secretId}`
    expect(env.SECRETS_KV.store.has(blobKey)).toBe(true)

    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)
    expect(res.body.data.orgsErased).toBe(1)

    // Gone from D1 (cascade)...
    expect(await env.DB.prepare('SELECT id FROM organisations WHERE id = ? LIMIT 1').bind(user.orgId).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM secrets WHERE id = ? LIMIT 1').bind(secretId).first()).toBeNull()
    // ...and gone from KV (the sweep this endpoint runs, not a D1 cascade).
    expect(env.SECRETS_KV.store.has(blobKey)).toBe(false)
  })

  it('FALSIFICATION: the last owner of a shared org is refused LAST_OWNER and NOTHING is deleted', async () => {
    const env = createTestEnv()
    // leaver is the sole owner; member is an ordinary member, so the org is shared (2 members) and
    // the leaver is its last owner.
    const leaver = await seedUser(env, { role: 'owner', password: PASSWORD })
    const other = await seedUser(env, { role: 'member', orgId: leaver.orgId })
    const projectId = await seedProject(env, leaver.orgId)
    const envId = await seedEnvironment(env, projectId)
    const secretId = await seedSecret(env, projectId, envId, 'API_KEY', 'super-secret')
    const blobKey = `secret:${secretId}`

    const res = await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'LAST_OWNER', message: 'An organisation must keep an owner. Make someone else an owner first.' })

    // Touched nothing: the user, the other member, the org, the secret and its KV blob all remain.
    expect(await userExists(env, leaver.userId)).toBe(true)
    expect(await userExists(env, other.userId)).toBe(true)
    expect(await env.DB.prepare('SELECT id FROM organisations WHERE id = ? LIMIT 1').bind(leaver.orgId).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT id FROM secrets WHERE id = ? LIMIT 1').bind(secretId).first()).not.toBeNull()
    expect(env.SECRETS_KV.store.has(blobKey)).toBe(true)
    // No user.delete audit row was written anywhere.
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.delete'").first<{ n: number }>()
    expect(audit?.n).toBe(0)
  })

  it('refusal writes no erasure_log row either', async () => {
    const env = createTestEnv()
    const leaver = await seedUser(env, { role: 'owner', password: PASSWORD })
    await seedUser(env, { role: 'member', orgId: leaver.orgId })
    const res = await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })
    expect(res.status).toBe(409)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM erasure_log').first<{ n: number }>()
    expect(n?.n).toBe(0)
  })
})

// GDPR accountability (issue #81, migration 0020): the one trail that MUST survive the erasure,
// because a sole-member deletion takes its org's audit_log with it. The record proves the act
// without retaining the personal data the act removed.
describe('DELETE /api/auth/account — durable erasure record', () => {
  it('survives a sole-member erasure that leaves no org and no audit_log behind', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })

    expect((await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: PASSWORD } })).status).toBe(200)

    // The org and its audit_log are gone — the only record of this deletion is erasure_log.
    expect(await env.DB.prepare('SELECT id FROM organisations WHERE id = ? LIMIT 1').bind(user.orgId).first()).toBeNull()
    const row = await env.DB.prepare('SELECT * FROM erasure_log WHERE erased_user_id = ? LIMIT 1')
      .bind(user.userId).first<Record<string, unknown>>()
    expect(row).not.toBeNull()
    expect(row?.['orgs_erased']).toBe(1)
    expect(row?.['actor_type']).toBe('user')
    expect(typeof row?.['erased_at']).toBe('string')
  })

  it('records the act but none of the personal data the act removed', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { email: 'erase-me@example.test', password: PASSWORD })
    const ua = 'hv-test-agent/1.0'

    expect((await call(env, 'DELETE', '/api/auth/account', {
      token: user.token, json: { password: PASSWORD }, headers: { 'user-agent': ua, 'cf-connecting-ip': '203.0.113.9' },
    })).status).toBe(200)

    const row = await env.DB.prepare('SELECT * FROM erasure_log WHERE erased_user_id = ? LIMIT 1')
      .bind(user.userId).first<Record<string, unknown>>()
    expect(row).not.toBeNull()
    // The whole row, serialised, must not carry the email, the user agent or the IP.
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain('erase-me@example.test')
    expect(serialised).not.toContain(ua)
    expect(serialised).not.toContain('203.0.113.9')
    // Its only columns are the act, not the subject.
    expect(Object.keys(row ?? {}).sort()).toEqual(['actor_type', 'erased_at', 'erased_user_id', 'id', 'orgs_erased'])
  })

  it('also records a shared-org deletion (orgs_erased 0)', async () => {
    const env = createTestEnv()
    const owner = await seedUser(env, { role: 'owner' })
    const leaver = await seedUser(env, { role: 'member', orgId: owner.orgId, password: PASSWORD })

    expect((await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })).status).toBe(200)

    const row = await env.DB.prepare('SELECT orgs_erased FROM erasure_log WHERE erased_user_id = ? LIMIT 1')
      .bind(leaver.userId).first<{ orgs_erased: number }>()
    expect(row?.orgs_erased).toBe(0)
  })

  it('a non-last-owner membership in a shared org is removed; the org and other members survive', async () => {
    const env = createTestEnv()
    // Two owners: the leaver is NOT the last owner, so deletion proceeds and the org survives.
    const leaver = await seedUser(env, { role: 'owner', password: PASSWORD })
    const coOwner = await seedUser(env, { role: 'owner', orgId: leaver.orgId })
    const projectId = await seedProject(env, leaver.orgId)
    const envId = await seedEnvironment(env, projectId)
    const secretId = await seedSecret(env, projectId, envId, 'KEEP_ME', 'still-here')

    const res = await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)
    expect(res.body.data.orgsErased).toBe(0)

    // The leaver is gone, their membership with them; the org, the co-owner and the secret survive.
    expect(await userExists(env, leaver.userId)).toBe(false)
    expect(await userExists(env, coOwner.userId)).toBe(true)
    expect(await env.DB.prepare('SELECT id FROM organisations WHERE id = ? LIMIT 1').bind(leaver.orgId).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT user_id FROM members WHERE org_id = ? AND user_id = ? LIMIT 1').bind(leaver.orgId, leaver.userId).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM secrets WHERE id = ? LIMIT 1').bind(secretId).first()).not.toBeNull()
  })
})

describe('DELETE /api/auth/account — the audit row (Decision B)', () => {
  it('lands in surviving orgs with the literal user id in resource_id, and survives the user delete', async () => {
    const env = createTestEnv()
    const leaver = await seedUser(env, { role: 'member', password: PASSWORD })
    // A second, shared org the leaver also belongs to (not as last owner) — it survives.
    await seedUser(env, { role: 'owner', orgId: leaver.orgId }) // makes leaver.orgId shared
    const sharedTwo = await seedOrg(env, 'Shared Two')
    await addMembership(env, { userId: leaver.userId, orgId: sharedTwo, role: 'admin' })
    await seedUser(env, { role: 'owner', orgId: sharedTwo })

    const res = await call(env, 'DELETE', '/api/auth/account', { token: leaver.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)
    expect(await userExists(env, leaver.userId)).toBe(false)

    const rows = await env.DB.prepare(
      "SELECT org_id, actor_id, resource_type, resource_id, metadata FROM audit_log WHERE action = 'user.delete' ORDER BY org_id",
    ).all<{ org_id: string; actor_id: string | null; resource_type: string; resource_id: string; metadata: string | null }>()

    // One row per surviving org the user belonged to.
    expect(rows.results.length).toBe(2)
    expect(new Set(rows.results.map((r) => r.org_id))).toEqual(new Set([leaver.orgId, sharedTwo]))
    for (const row of rows.results) {
      // actor_id was SET NULL when the user row went...
      expect(row.actor_id).toBeNull()
      // ...but resource_id still names the deleted user as a literal string.
      expect(row.resource_id).toBe(leaver.userId)
      expect(row.resource_type).toBe('user')
      // Bounded, non-secret metadata: a self flag and the count of erased orgs (0 here).
      expect(JSON.parse(row.metadata ?? '{}')).toEqual({ self: true, orgs_erased: 0 })
    }
  })

  it('a sole-member deletion files no audit row (the only org is erased with it)', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { password: PASSWORD })

    const res = await call(env, 'DELETE', '/api/auth/account', { token: user.token, json: { password: PASSWORD } })
    expect(res.status).toBe(200)

    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.delete'").first<{ n: number }>()
    expect(audit?.n).toBe(0)
  })
})
