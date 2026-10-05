import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, createTestEnv, seedApiKey, seedUser } from './helpers/env'
import { beginGithub, githubCallback } from './helpers/auth-oauth'

vi.mock('../src/lib/oauth', async (orig) => ({
  ...(await orig<typeof import('../src/lib/oauth')>()),
  exchangeGitHubCode: vi.fn(async () => 'gh-access-token'),
  fetchGitHubIdentity: vi.fn(),
}))

import { fetchGitHubIdentity } from '../src/lib/oauth'

const PASSWORD = 'a-very-long-password-123'

async function userRow(env: ReturnType<typeof createTestEnv>, email: string) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<Record<string, any>>()
}

beforeEach(() => {
  vi.mocked(fetchGitHubIdentity).mockReset()
})

describe('register / login', () => {
  it('roundtrips and stores email_verified = 0', async () => {
    const env = createTestEnv()
    const reg = await call(env, 'POST', '/api/auth/register', {
      json: { email: 'Ann@x.com', password: PASSWORD, organisationName: 'Ann Org' },
    })
    expect(reg.status).toBe(201)
    // `orgs` since issue #82: the org is chosen explicitly at sign-in and the full list rides along
    // so the dashboard's switcher needs no second round trip.
    expect(Object.keys(reg.body.data).sort()).toEqual(['emailVerified', 'expiresIn', 'orgId', 'orgs', 'token', 'userId'])
    expect(reg.body.data.expiresIn).toBe(900)
    expect(reg.body.data.orgs).toEqual([
      { id: reg.body.data.orgId, name: 'Ann Org', slug: expect.stringContaining('ann-org-'), plan: 'free', role: 'owner' },
    ])
    expect((await userRow(env, 'ann@x.com'))?.['email_verified']).toBe(0)

    const login = await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: PASSWORD } })
    expect(login.status).toBe(200)
    expect(login.body.data).toMatchObject({ userId: reg.body.data.userId, orgId: reg.body.data.orgId, role: 'owner' })
    expect(login.body.data.orgs).toEqual(reg.body.data.orgs)
    expect(typeof login.body.data.token).toBe('string')
  })

  it('returns identical 401 bodies for unknown user, wrong password and OAuth-only user', async () => {
    const env = createTestEnv()
    await seedUser(env, { email: 'real@x.com', password: PASSWORD })
    const oauthId = 'usr_oauthonly'
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at, email_verified) VALUES (?, 'o@x.com', '', '', 'github', '1', ?, 1)")
      .bind(oauthId, new Date().toISOString()).run()

    const unknown = await call(env, 'POST', '/api/auth/login', { json: { email: 'nobody@x.com', password: PASSWORD } })
    const wrong = await call(env, 'POST', '/api/auth/login', { json: { email: 'real@x.com', password: 'wrong-password-xx' } })
    const oauthOnly = await call(env, 'POST', '/api/auth/login', { json: { email: 'o@x.com', password: 'whatever-password' } })
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(oauthOnly.status).toBe(401)
    expect(unknown.body).toEqual(wrong.body)
    expect(oauthOnly.body).toEqual(wrong.body)
  })
})

describe('OAuth account linking', () => {
  it('ATTACK: a pre-registered unverified account is claimed by the real owner and the attacker is locked out', async () => {
    const env = createTestEnv()
    const attacker = await call(env, 'POST', '/api/auth/register', {
      json: { email: 'victim@x.com', password: PASSWORD, organisationName: 'Evil Org' },
    })
    expect(attacker.status).toBe(201)
    const attackerToken = attacker.body.data.token as string
    const attackerKey = await seedApiKey(env, attacker.body.data.userId)
    expect((await call(env, 'GET', '/api/projects', { token: attackerToken })).status).toBe(200)
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '777', login: 'victim', name: 'V', email: 'victim@x.com' })

    // The victim signs in with GitHub (the provider verified the address): they get the account.
    await new Promise((r) => setTimeout(r, 1100)) // JWT iat is in whole seconds
    const res = await githubCallback(env)
    expect(res.fragment.get('error')).toBeNull()
    expect(res.fragment.get('token')).toBeTruthy()
    expect(res.fragment.get('userId')).toBe(attacker.body.data.userId)
    expect(res.fragment.get('notice')).toBe('account_linked')
    const row = await userRow(env, 'victim@x.com')
    expect(row).toMatchObject({ provider: 'github', provider_id: '777', email_verified: 1, password_hash: '', salt: '' })

    // Everything the attacker held is dead.
    expect((await call(env, 'POST', '/api/auth/login', { json: { email: 'victim@x.com', password: PASSWORD } })).status).toBe(401)
    expect((await call(env, 'GET', '/api/projects', { token: attackerToken })).status).toBe(401)
    expect((await call(env, 'GET', '/api/projects', { token: attackerKey.rawKey })).status).toBe(401)
    // The new session works.
    expect((await call(env, 'GET', '/api/projects', { token: res.fragment.get('token') as string })).status).toBe(200)
    const audit = await env.DB.prepare("SELECT org_id FROM audit_log WHERE action = 'auth.oauth.account_takeover'").first<{ org_id: string }>()
    expect(audit?.org_id).toBe(attacker.body.data.orgId)
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('links by email when the existing account is verified', async () => {
    const env = createTestEnv()
    const u = await seedUser(env, { email: 'ok@x.com', emailVerified: true })
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '42', login: 'ok', name: null, email: 'ok@x.com' })

    const res = await githubCallback(env)
    expect(res.fragment.get('error')).toBeNull()
    expect(res.fragment.get('userId')).toBe(u.userId)
    expect(res.fragment.get('token')).toBeTruthy()
    const row = await userRow(env, 'ok@x.com')
    expect(row).toMatchObject({ provider: 'github', provider_id: '42' })
  })

  it('creates a fresh verified user with an org, and keeps working by provider id', async () => {
    const env = createTestEnv()
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '9', login: 'newbie', name: 'New B', email: 'new@x.com' })

    const first = await githubCallback(env)
    expect(first.fragment.get('token')).toBeTruthy()
    const row = await userRow(env, 'new@x.com')
    expect(row?.['email_verified']).toBe(1)
    const member = await env.DB.prepare('SELECT org_id, role FROM members WHERE user_id = ?').bind(row?.['id']).first<{ org_id: string; role: string }>()
    expect(member?.role).toBe('owner')
    expect(first.fragment.get('orgId')).toBe(member?.org_id)

    const second = await githubCallback(env)
    expect(second.fragment.get('userId')).toBe(row?.['id'])
  })

  it('keeps logging in an already provider-linked account even if email matches nothing else', async () => {
    const env = createTestEnv()
    const u = await seedUser(env, { email: 'linked@x.com', emailVerified: false })
    await env.DB.prepare("UPDATE users SET provider = 'github', provider_id = '5' WHERE id = ?").bind(u.userId).run()
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '5', login: 'l', name: null, email: 'linked@x.com' })
    const res = await githubCallback(env)
    expect(res.fragment.get('userId')).toBe(u.userId)
  })

  it('sets a PKCE challenge and an HttpOnly, SameSite=Lax verifier cookie when the flow starts', async () => {
    const env = createTestEnv()
    const begun = await beginGithub(env)
    expect(begun.authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(begun.authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(begun.setCookie).toMatch(/hv_oauth=/)
    expect(begun.setCookie).toMatch(/HttpOnly/i)
    expect(begun.setCookie).toMatch(/SameSite=Lax/i)
    // The verifier (cookie) is not in any URL.
    const verifier = begun.cookie.split('=')[1] ?? ''
    expect(begun.authorize.toString()).not.toContain(verifier)
  })

  it('ATTACK: login CSRF - a callback URL replayed in a victim browser without the cookie is refused', async () => {
    const env = createTestEnv()
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '1', login: 'attacker', name: null, email: 'attacker@x.com' })
    const attackerFlow = await beginGithub(env)
    const victim = await githubCallback(env, { state: attackerFlow.state, cookie: null })
    expect(victim.fragment.get('error')).toBe('invalid_state')
    expect(victim.fragment.get('token')).toBeNull()
    // ...and a victim who has a cookie from a different flow is refused too.
    const other = await beginGithub(env)
    const mismatched = await githubCallback(env, { state: attackerFlow.state, cookie: other.cookie })
    expect(mismatched.fragment.get('error')).toBe('invalid_state')
    expect(fetchGitHubIdentity).not.toHaveBeenCalled()
  })

  it('a state is single use: the cookie is cleared, so a replay fails', async () => {
    const env = createTestEnv()
    vi.mocked(fetchGitHubIdentity).mockResolvedValue({ id: '3', login: 'once', name: null, email: 'once@x.com' })
    const begun = await beginGithub(env)
    const first = await githubCallback(env, { state: begun.state, cookie: begun.cookie })
    expect(first.fragment.get('token')).toBeTruthy()
    expect(first.setCookie).toMatch(/hv_oauth=;|Max-Age=0/i)
    // Browser dropped the cookie; replaying the same URL has none.
    const replay = await githubCallback(env, { state: begun.state, cookie: null })
    expect(replay.fragment.get('error')).toBe('invalid_state')
  })

  it('rejects an invalid state', async () => {
    const env = createTestEnv()
    const res = await githubCallback(env, { state: 'bogus.state' })
    expect(res.fragment.get('error')).toBe('invalid_state')
    expect(res.fragment.get('token')).toBeNull()
    expect(fetchGitHubIdentity).not.toHaveBeenCalled()
  })
})

describe('API keys', () => {
  it('create returns id and raw key; audit resourceId is the key id', async () => {
    const env = createTestEnv()
    const u = await seedUser(env)
    const res = await call(env, 'POST', '/api/auth/api-keys', { token: u.token, json: { name: 'ci key' } })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: 'ci key', expiresAt: null })
    expect(res.body.data.id).toMatch(/^key_/)
    expect(res.body.data.apiKey).toMatch(/^hv_live_/)
    const audit = await env.DB.prepare("SELECT resource_id FROM audit_log WHERE action = 'auth.api_key.create'").first<{ resource_id: string }>()
    expect(audit?.resource_id).toBe(res.body.data.id)
  })

  it('rejects a past expiresAt with 400', async () => {
    const env = createTestEnv()
    const u = await seedUser(env)
    const res = await call(env, 'POST', '/api/auth/api-keys', {
      token: u.token,
      json: { name: 'old', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('VALIDATION_ERROR')
  })

  it('list returns only own keys and never hash or raw key', async () => {
    const env = createTestEnv()
    const a = await seedUser(env)
    const b = await seedUser(env)
    const created = await call(env, 'POST', '/api/auth/api-keys', { token: a.token, json: { name: 'mine' } })
    await seedApiKey(env, b.userId)

    const res = await call(env, 'GET', '/api/auth/api-keys', { token: a.token })
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    // `orgId` since issue #82: a key acts in the org it was created in, and the owner needs to see
    // which one that is (a NULL there means the key predates migration 0018 and no longer works).
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'orgId', 'revokedAt'])
    expect(res.body.data[0].orgId).toBe(a.orgId)
    const text = JSON.stringify(res.body)
    expect(text).not.toContain(created.body.data.apiKey)
    expect(text).not.toContain('key_hash')
    const hash = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE id = ?').bind(created.body.data.id).first<{ key_hash: string }>()
    expect(text).not.toContain(hash!.key_hash)
  })

  it('delete by id works, other user gets 404, and a revoked key stops authenticating', async () => {
    const env = createTestEnv()
    const a = await seedUser(env)
    const b = await seedUser(env)
    const created = await call(env, 'POST', '/api/auth/api-keys', { token: a.token, json: { name: 'kk' } })
    const { id, apiKey } = created.body.data

    expect((await call(env, 'GET', '/api/projects', { token: apiKey })).status).toBe(200)
    expect((await call(env, 'DELETE', `/api/auth/api-keys/${id}`, { token: b.token })).status).toBe(404)
    expect((await call(env, 'GET', '/api/projects', { token: apiKey })).status).toBe(200)

    const del = await call(env, 'DELETE', `/api/auth/api-keys/${id}`, { token: a.token })
    expect(del.status).toBe(200)
    expect(del.body.data).toEqual({ revoked: true })
    expect((await call(env, 'GET', '/api/projects', { token: apiKey })).status).toBe(401)
  })
})
