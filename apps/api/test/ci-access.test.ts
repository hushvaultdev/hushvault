import { describe, expect, it } from 'vitest'
import { signCiToken, verifyCiToken, CI_TOKEN_TTL_SECONDS } from '../src/lib/ci-tokens'
import { ciTokenMayReach } from '../src/middleware/auth'
import { call, createTestEnv, seedApiKey, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { seedSecret } from './helpers/env-secrets'

async function world(env: TestEnv) {
  const admin = await seedUser(env, { role: 'admin' })
  const projectId = await seedProject(env, admin.orgId)
  const envId = await seedEnvironment(env, projectId)
  await seedSecret(env, projectId, envId, 'DB_URL', 'value-CANARY-ci')
  return { admin, projectId, envId }
}

const rule = (envId: string, over: Record<string, unknown> = {}) => ({ envId, repository: 'Acme/App', ref: 'refs/heads/main', ...over })

describe('CI access rules', () => {
  it('creates, lists and deletes a rule; stores the repository lowercased and audits both changes', async () => {
    const env = createTestEnv()
    const { admin, envId } = await world(env)
    const created = await call(env, 'POST', '/api/ci-access/github/rules', { token: admin.token, json: rule(envId, { repositoryId: '12345' }) })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ envId, repository: 'acme/app', repositoryId: '12345', ref: 'refs/heads/main', environment: null })

    const list = await call(env, 'GET', '/api/ci-access/github/rules', { token: admin.token })
    expect(list.body.data).toHaveLength(1)

    expect((await call(env, 'DELETE', `/api/ci-access/github/rules/${created.body.data.id}`, { token: admin.token })).status).toBe(200)
    expect((await call(env, 'GET', '/api/ci-access/github/rules', { token: admin.token })).body.data).toHaveLength(0)
    const actions = await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'ci.rule.%' ORDER BY timestamp").all<{ action: string }>()
    expect(actions.results.map((a) => a.action)).toEqual(['ci.rule.create', 'ci.rule.delete'])
  })

  it('rejects a malformed repository, both or neither of ref/environment, and a duplicate rule', async () => {
    const env = createTestEnv()
    const { admin, envId } = await world(env)
    const post = (json: unknown) => call(env, 'POST', '/api/ci-access/github/rules', { token: admin.token, json })
    expect((await post(rule(envId, { repository: 'not-a-repo' }))).status).toBe(400)
    expect((await post(rule(envId, { environment: 'production' }))).status).toBe(400) // both ref and environment
    expect((await post({ envId, repository: 'acme/app' })).status).toBe(400) // neither
    expect((await post(rule(envId, { ref: 'main' }))).status).toBe(400) // not a refs/ path
    expect((await post(rule(envId))).status).toBe(201)
    expect((await post(rule(envId))).status).toBe(409)
  })

  it('IDOR: an environment in another organisation cannot be granted, and rules are per organisation', async () => {
    const env = createTestEnv()
    const a = await world(env)
    const b = await world(env)
    expect((await call(env, 'POST', '/api/ci-access/github/rules', { token: a.admin.token, json: rule(b.envId) })).status).toBe(404)
    await call(env, 'POST', '/api/ci-access/github/rules', { token: a.admin.token, json: rule(a.envId) })
    expect((await call(env, 'GET', '/api/ci-access/github/rules', { token: b.admin.token })).body.data).toEqual([])
  })

  it('API keys, members, viewers and demoted admins are refused', async () => {
    const env = createTestEnv()
    const { admin, envId } = await world(env)
    const key = await seedApiKey(env, admin.userId)
    expect((await call(env, 'GET', '/api/ci-access/github/rules', { token: key.rawKey })).status).toBe(403)
    const member = await seedUser(env, { role: 'member', orgId: admin.orgId })
    expect((await call(env, 'POST', '/api/ci-access/github/rules', { token: member.token, json: rule(envId) })).status).toBe(403)
    await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE user_id = ?").bind(admin.userId).run()
    expect((await call(env, 'GET', '/api/ci-access/github/rules', { token: admin.token })).status).toBe(403)
    expect((await call(env, 'GET', '/api/ci-access/github/rules')).status).toBe(401)
  })
})

describe('CI tokens', () => {
  const SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret'

  it('round-trips, expires, and is rejected under a different secret or a tampered payload', async () => {
    const issued = await signCiToken({ ruleId: 'ocr_1', orgId: 'org_1', envId: 'env_1' }, SECRET)
    expect(issued.expiresIn).toBe(CI_TOKEN_TTL_SECONDS)
    expect(await verifyCiToken(issued.token, SECRET)).toMatchObject({ kind: 'ci-env', orgId: 'org_1', envId: 'env_1', sub: 'ocr_1' })
    expect(await verifyCiToken(issued.token, 'another-secret-another-secret-xx')).toBeNull()
    expect(await verifyCiToken(issued.token, SECRET, new Date(Date.now() + (CI_TOKEN_TTL_SECONDS + 5) * 1000))).toBeNull()
    const [h, p, s] = issued.token.split('.') as [string, string, string]
    const forged = Buffer.from(JSON.stringify({ kind: 'ci-env', sub: 'ocr_1', orgId: 'org_1', envId: 'env_OTHER', iss: 'hushvault', aud: 'hushvault-api', iat: 0, exp: 9999999999 })).toString('base64url')
    expect(await verifyCiToken(`${h}.${forged}.${s}`, SECRET)).toBeNull()
    expect(await verifyCiToken(`${h}.${p}`, SECRET)).toBeNull()
    expect(await verifyCiToken('not.a.token', SECRET)).toBeNull()
  })

  it('a session token is not a CI token, and a CI token is not a session token', async () => {
    const env = createTestEnv()
    const { admin, envId } = await world(env)
    expect(await verifyCiToken(admin.token, env.JWT_SECRET)).toBeNull()
    const ci = await signCiToken({ ruleId: 'ocr_1', orgId: admin.orgId, envId }, env.JWT_SECRET)
    // The session verifier refuses it, so it can never be mistaken for a user session.
    const { verifyJwt } = await import('../src/lib/auth')
    await expect(verifyJwt(ci.token, env.JWT_SECRET)).rejects.toThrow()
  })

  it('reads only its own environment, read-only, and nothing else in the API', async () => {
    const env = createTestEnv()
    const { admin, envId, projectId } = await world(env)
    const otherEnv = await seedEnvironment(env, projectId, 'other')
    const ci = await signCiToken({ ruleId: 'ocr_1', orgId: admin.orgId, envId }, env.JWT_SECRET)

    const ok = await call(env, 'GET', `/api/environments/${envId}/resolved?values=true`, { token: ci.token })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).toContain('value-CANARY-ci')

    // Everything else is refused by the middleware allowlist, including the sibling environment.
    for (const [method, path] of [
      ['GET', `/api/environments/${otherEnv}/resolved`],
      ['GET', '/api/environments'],
      ['GET', '/api/projects'],
      ['GET', '/api/secrets?envId=' + envId],
      ['GET', '/api/audit'],
      ['GET', '/api/auth/api-keys'],
      ['GET', '/api/integrations/connections'],
      ['GET', '/api/ci-access/github/rules'],
    ] as const) {
      expect((await call(env, method, path, { token: ci.token })).status, `${method} ${path}`).toBe(403)
    }
    for (const [method, path, json] of [
      ['POST', '/api/secrets', { projectId, envId, name: 'X', value: 'y' }],
      ['DELETE', `/api/environments/${envId}/resolved`, undefined],
      ['POST', '/api/auth/api-keys', { name: 'k' }],
    ] as const) {
      expect((await call(env, method, path, { token: ci.token, ...(json ? { json } : {}) })).status, `${method} ${path}`).toBe(403)
    }
  })

  it('the allowlist is exact: no prefix, suffix or method confusion', () => {
    expect(ciTokenMayReach('GET', '/api/environments/env_1/resolved', 'env_1')).toBe(true)
    expect(ciTokenMayReach('GET', '/api/environments/env_1/resolved', 'env_2')).toBe(false)
    expect(ciTokenMayReach('POST', '/api/environments/env_1/resolved', 'env_1')).toBe(false)
    expect(ciTokenMayReach('GET', '/api/environments/env_1/resolved/extra', 'env_1')).toBe(false)
    expect(ciTokenMayReach('GET', '/api/environments/env_1/resolved/../../secrets', 'env_1')).toBe(false)
    expect(ciTokenMayReach('GET', '/api/environments/env_11/resolved', 'env_1')).toBe(false)
  })

  it('a read by a CI token is audited with no actor id (there is no person behind it)', async () => {
    const env = createTestEnv()
    const { admin, envId } = await world(env)
    const ci = await signCiToken({ ruleId: 'ocr_1', orgId: admin.orgId, envId }, env.JWT_SECRET)
    await call(env, 'GET', `/api/environments/${envId}/resolved?values=true`, { token: ci.token })
    const row = await env.DB.prepare("SELECT actor_id, actor_type, org_id FROM audit_log WHERE action = 'secret.read_bulk' ORDER BY timestamp DESC LIMIT 1").first<{ actor_id: string | null; actor_type: string; org_id: string }>()
    expect(row).toMatchObject({ actor_id: null, actor_type: 'system', org_id: admin.orgId })
  })
})
