import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptCredentialWithRing, decryptSecretWithRing, encryptSecretWithRing, loadKeyRing } from '../src/crypto/envelope'
import { registerProvider, type IntegrationProvider, type VerifyResult } from '../src/integrations/provider'
import { readCredential } from '../src/lib/integration-credentials'
import { call, createTestEnv, seedApiKey, seedUser, type TestEnv } from './helpers/env'

const CANARY = 'cf-token-CANARY-9f3a1b7c-never-leak-me'
let verifyResult: VerifyResult = { ok: true }
const verifyCalls: string[] = []

const mock: IntegrationProvider = {
  id: 'cloudflare-workers',
  async verify(credential) {
    verifyCalls.push(credential)
    return verifyResult
  },
  parseConfig(config) {
    const c = config as { accountId?: unknown }
    if (c.accountId !== undefined && typeof c.accountId !== 'string') return null
    return c.accountId ? { accountId: c.accountId } : {}
  },
}

let env: TestEnv
let admin: Awaited<ReturnType<typeof seedUser>>
let logged: string[]

const post = (token: string, json: unknown) => call(env, 'POST', '/api/integrations/connections', { token, json })

beforeEach(() => {
  registerProvider(mock)
  verifyResult = { ok: true }
  verifyCalls.length = 0
  env = createTestEnv()
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

async function setupAdmin() {
  admin = await seedUser(env, { role: 'admin' })
}

describe('connections: create / list / rotate / revoke', () => {
  it('round-trips and never returns, stores in plaintext, or logs the credential', async () => {
    await setupAdmin()
    const created = await post(admin.token, { provider: 'cloudflare-workers', label: 'prod', credential: CANARY, config: { accountId: 'acc123' } })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ provider: 'cloudflare-workers', label: 'prod', config: { accountId: 'acc123' } })
    expect(created.body.data.id).toMatch(/^icn_/)
    expect(verifyCalls).toEqual([CANARY])

    const list = await call(env, 'GET', '/api/integrations/connections', { token: admin.token })
    expect(list.body.data).toHaveLength(1)
    const rotated = await call(env, 'PUT', `/api/integrations/connections/${created.body.data.id}/credential`, { token: admin.token, json: { credential: `${CANARY}-v2` } })
    expect(rotated.status).toBe(200)

    // No response contains the credential or any ciphertext column.
    for (const body of [created.body, list.body, rotated.body]) {
      const text = JSON.stringify(body)
      expect(text).not.toContain('CANARY')
      expect(text).not.toMatch(/encrypted_credential|encryptedCredential|wrapped_dek|wrappedDek/)
    }
    // Not stored in plaintext, and never logged.
    const row = await env.DB.prepare('SELECT * FROM integration_connections').first<Record<string, unknown>>()
    expect(JSON.stringify(row)).not.toContain('CANARY')
    expect(String(row?.['encrypted_credential'])).toMatch(/^c2:/)
    expect(logged.join('\n')).not.toContain('CANARY')

    // The stored value decrypts to the rotated credential for its own org only.
    expect(await readCredential(env as never, admin.orgId, created.body.data.id)).toBe(`${CANARY}-v2`)
    expect(await readCredential(env as never, 'org_other', created.body.data.id)).toBeNull()

    const revoked = await call(env, 'DELETE', `/api/integrations/connections/${created.body.data.id}`, { token: admin.token })
    expect(revoked.body).toEqual({ data: { revoked: true } })
    expect((await call(env, 'GET', '/api/integrations/connections', { token: admin.token })).body.data).toHaveLength(0)
    const audits = await env.DB.prepare("SELECT action, resource_id FROM audit_log WHERE action LIKE 'integration.%' ORDER BY timestamp").all<{ action: string; resource_id: string }>()
    expect(audits.results.map((a) => a.action)).toEqual(['integration.connect', 'integration.update', 'integration.revoke'])
    expect(JSON.stringify(audits.results)).not.toContain('CANARY')
  })

  it('rejects a credential the provider refuses and stores nothing; maps provider failures to fixed codes', async () => {
    await setupAdmin()
    verifyResult = { ok: false, code: 'PROVIDER_AUTH' }
    const bad = await post(admin.token, { provider: 'cloudflare-workers', label: 'x', credential: CANARY })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toBe('CREDENTIAL_REJECTED')
    expect(JSON.stringify(bad.body)).not.toContain('CANARY')
    verifyResult = { ok: false, code: 'PROVIDER_ERROR' }
    expect((await post(admin.token, { provider: 'cloudflare-workers', label: 'x', credential: CANARY })).status).toBe(502)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM integration_connections').first<{ n: number }>())?.n).toBe(0)
  })

  it('rejects unknown providers, invalid config, duplicates and over-long input without echoing it', async () => {
    await setupAdmin()
    expect((await post(admin.token, { provider: 'slack', label: 'x', credential: CANARY })).body.error).toBe('UNSUPPORTED_PROVIDER')
    expect((await post(admin.token, { provider: 'cloudflare-workers', label: 'x', credential: CANARY, config: { accountId: 5 } })).status).toBe(400)
    expect((await post(admin.token, { provider: 'cloudflare-workers', label: 'x', credential: 'short' })).status).toBe(400)
    expect((await post(admin.token, { provider: 'cloudflare-workers', label: 'dup', credential: CANARY })).status).toBe(201)
    expect((await post(admin.token, { provider: 'cloudflare-workers', label: 'dup', credential: CANARY })).status).toBe(409)
    const huge = await post(admin.token, { provider: 'cloudflare-workers', label: 'big', credential: 'x'.repeat(5000) })
    expect(huge.status).toBe(400)
    expect(JSON.stringify(huge.body)).not.toContain('xxxxx')
  })
})

describe('access control', () => {
  it('API keys are refused on every management endpoint, even an admin key', async () => {
    await setupAdmin()
    const key = await seedApiKey(env, admin.userId)
    const created = await post(admin.token, { provider: 'cloudflare-workers', label: 'p', credential: CANARY })
    const id = created.body.data.id as string
    for (const [method, path, json] of [
      ['POST', '/api/integrations/connections', { provider: 'cloudflare-workers', label: 'k', credential: CANARY }],
      ['GET', '/api/integrations/connections', undefined],
      ['PUT', `/api/integrations/connections/${id}/credential`, { credential: CANARY }],
      ['DELETE', `/api/integrations/connections/${id}`, undefined],
    ] as const) {
      const res = await call(env, method, path, { token: key.rawKey, ...(json ? { json } : {}) })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('members and viewers are refused; unauthenticated gets 401', async () => {
    await setupAdmin()
    const member = await seedUser(env, { role: 'member', orgId: admin.orgId })
    const viewer = await seedUser(env, { role: 'viewer', orgId: admin.orgId })
    for (const u of [member, viewer]) {
      expect((await post(u.token, { provider: 'cloudflare-workers', label: 'm', credential: CANARY })).status).toBe(403)
      expect((await call(env, 'GET', '/api/integrations/connections', { token: u.token })).status).toBe(403)
    }
    expect((await call(env, 'GET', '/api/integrations/connections')).status).toBe(401)
  })

  it('IDOR: another organisation cannot see, rotate or delete a connection', async () => {
    await setupAdmin()
    const created = await post(admin.token, { provider: 'cloudflare-workers', label: 'mine', credential: CANARY })
    const id = created.body.data.id as string
    const other = await seedUser(env, { role: 'admin' })
    expect((await call(env, 'GET', '/api/integrations/connections', { token: other.token })).body.data).toEqual([])
    expect((await call(env, 'PUT', `/api/integrations/connections/${id}/credential`, { token: other.token, json: { credential: 'attacker-credential-1' } })).status).toBe(404)
    expect((await call(env, 'DELETE', `/api/integrations/connections/${id}`, { token: other.token })).status).toBe(404)
    expect(await readCredential(env as never, admin.orgId, id)).toBe(CANARY)
  })

  it('providers list is available to any signed-in user and marks only implemented providers connectable', async () => {
    await setupAdmin()
    const viewer = await seedUser(env, { role: 'viewer', orgId: admin.orgId })
    const res = await call(env, 'GET', '/api/integrations/providers', { token: viewer.token })
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(res.body.data.map((p: { id: string }) => [p.id, p]))
    expect(byId['cloudflare-workers'].connectable).toBe(true)
    expect(byId['slack'].connectable).toBe(false)
    expect(byId['slack'].status).toBe('planned')
  })

  it('the secret-scanner callback stays reachable without auth', async () => {
    const res = await call(env, 'POST', '/api/integrations/secret-scanner/github', { json: [] })
    // It answers with its own signature check, not the dashboard auth middleware.
    expect(res.body.message).toBe('Missing signature headers')
  })
})

describe('credential encryption', () => {
  it('ATTACK: a credential blob moved to another connection or org fails closed', async () => {
    await setupAdmin()
    const a = await post(admin.token, { provider: 'cloudflare-workers', label: 'a', credential: `${CANARY}-A` })
    const b = await post(admin.token, { provider: 'cloudflare-workers', label: 'b', credential: `${CANARY}-B` })
    const rowA = await env.DB.prepare('SELECT encrypted_credential, wrapped_dek FROM integration_connections WHERE id = ?').bind(a.body.data.id).first<{ encrypted_credential: string; wrapped_dek: string }>()
    await env.DB.prepare('UPDATE integration_connections SET encrypted_credential = ?, wrapped_dek = ? WHERE id = ?').bind(rowA!.encrypted_credential, rowA!.wrapped_dek, b.body.data.id).run()
    expect(await readCredential(env as never, admin.orgId, b.body.data.id)).toBeNull()
    expect(await readCredential(env as never, admin.orgId, a.body.data.id)).toBe(`${CANARY}-A`)
  })

  it('ATTACK: a secret blob cannot be used as a credential, nor a credential as a secret', async () => {
    await setupAdmin()
    const ring = loadKeyRing(env)
    const created = await post(admin.token, { provider: 'cloudflare-workers', label: 'a', credential: CANARY })
    const id = created.body.data.id as string
    const sec = await encryptSecretWithRing('some-secret-value', ring, { projectId: 'prj_1', envId: 'env_1', secretId: id })
    await env.DB.prepare('UPDATE integration_connections SET encrypted_credential = ?, wrapped_dek = ? WHERE id = ?').bind(sec.encryptedValue, sec.wrappedDek, id).run()
    expect(await readCredential(env as never, admin.orgId, id)).toBeNull()

    const row = await post(admin.token, { provider: 'cloudflare-workers', label: 'b', credential: CANARY })
    const cred = await env.DB.prepare('SELECT encrypted_credential, wrapped_dek FROM integration_connections WHERE id = ?').bind(row.body.data.id).first<{ encrypted_credential: string; wrapped_dek: string }>()
    await expect(decryptSecretWithRing(cred!.encrypted_credential, cred!.wrapped_dek, 'v1', ring, { projectId: 'prj_1', envId: 'env_1', secretId: row.body.data.id }, 2)).rejects.toThrow()
  })

  it('a decryption failure is opaque (null), and the wrong org id cannot decrypt', async () => {
    await setupAdmin()
    const created = await post(admin.token, { provider: 'cloudflare-workers', label: 'a', credential: CANARY })
    await env.DB.prepare("UPDATE integration_connections SET wrapped_dek = 'c2:AAAA:BBBB'").run()
    expect(await readCredential(env as never, admin.orgId, created.body.data.id)).toBeNull()
    await expect(decryptCredentialWithRing('c2:x:y', 'c2:x:y', 'v1', loadKeyRing(env), { orgId: 'o', connectionId: 'c' })).rejects.toThrow()
    expect(logged.join('\n')).not.toContain('CANARY')
  })
})
