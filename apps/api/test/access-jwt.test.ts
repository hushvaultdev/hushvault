import { describe, expect, it, vi, afterEach } from 'vitest'
import { app } from '../src/index'
import { call, createTestEnv, seedUser, type TestEnv } from './helpers/env'

const TEAM_DOMAIN = 'https://hushvault.cloudflareaccess.com'
const JWKS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`
const AUD = 'test-access-aud'

const b64url = (input: string | Uint8Array) => Buffer.from(typeof input === 'string' ? input : input).toString('base64url')

async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  return { pair, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: jwk['n'], e: jwk['e'] } }
}

async function makeAccessToken(key: Awaited<ReturnType<typeof makeKey>>, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.jwk.kid }))
  const p = b64url(JSON.stringify({ iss: TEAM_DOMAIN, aud: AUD, iat: now, nbf: now, exp: now + 300, email: 'admin@example.test', ...claims }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}

function serveJwks(keys: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } })))
}

function withAccess(overrides: Record<string, unknown> = {}): TestEnv {
  return createTestEnv({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD, ...overrides })
}

async function seedPlatformAdmin(env: TestEnv, email = 'admin@example.test') {
  const { userId, token } = await seedUser(env, { email })
  await env.DB.prepare('INSERT INTO platform_admins (user_id, granted_at) VALUES (?, ?)').bind(userId, new Date().toISOString()).run()
  return { userId, token }
}

/** Drive the real app at an absolute URL, so the hostname the middleware reads is controllable. */
async function callAt(env: TestEnv, url: string, opts: { token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  const res = await app.request(url, { method: 'GET', headers }, env)
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

afterEach(() => vi.unstubAllGlobals())

describe('requireAccessJwt', () => {
  it('returns 503 in production when Access is unconfigured', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'production' })
    const { token } = await seedPlatformAdmin(env)
    const res = await call(env, 'GET', '/api/admin/orgs', { token })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('ACCESS_NOT_CONFIGURED')
  })

  it('returns 503 outside production, outside localhost, when Access is unconfigured (fails closed, not open)', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'dev' })
    const { token } = await seedPlatformAdmin(env)
    const res = await callAt(env, 'https://api-beta.hushvault.dev/api/admin/orgs', { token })
    expect(res.status).toBe(503)
  })

  it('bypasses Access on localhost outside production, but still enforces requireAuth/requirePlatformAdmin', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'dev' })
    const { token } = await seedPlatformAdmin(env)
    expect((await callAt(env, 'http://localhost/api/admin/orgs', { token })).status).toBe(200)
    expect((await callAt(env, 'http://127.0.0.1/api/admin/orgs', { token })).status).toBe(200)
    const { token: notAdmin } = await seedUser(env, { role: 'owner' })
    expect((await callAt(env, 'http://localhost/api/admin/orgs', { token: notAdmin })).status).toBe(403)
  })

  it('ATTACK: a spoofed Host header does not grant the localhost bypass in production', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'production' })
    const { token } = await seedPlatformAdmin(env)
    const res = await callAt(env, 'https://api.hushvault.dev/api/admin/orgs', { token, headers: { host: 'localhost' } })
    expect(res.status).toBe(503)
  })

  it('rejects a missing Access header once configured', async () => {
    const env = withAccess()
    const { token } = await seedPlatformAdmin(env)
    const res = await callAt(env, 'https://api.hushvault.dev/api/admin/orgs', { token })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' })
  })

  it('rejects an expired, wrong-audience, wrong-issuer or badly signed Access JWT, all with the same opaque message', async () => {
    const env = withAccess()
    const { token } = await seedPlatformAdmin(env)
    const key = await makeKey('k1')
    const evil = await makeKey('k1')
    serveJwks([key.jwk])

    const now = Math.floor(Date.now() / 1000)
    const cases = [
      await makeAccessToken(key, { exp: now - 120 }),
      await makeAccessToken(key, { aud: 'someone-else' }),
      await makeAccessToken(key, { iss: 'https://evil.example' }),
      await makeAccessToken(evil), // signed by the wrong key, same kid
    ]
    for (const accessToken of cases) {
      const res = await callAt(env, 'https://api.hushvault.dev/api/admin/orgs', {
        token,
        headers: { 'cf-access-jwt-assertion': accessToken },
      })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'UNAUTHORIZED', message: 'Access verification required' })
    }
  })

  it('rejects a valid Access JWT whose email does not match the signed-in user', async () => {
    const env = withAccess()
    const { token } = await seedPlatformAdmin(env, 'admin@example.test')
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    const accessToken = await makeAccessToken(key, { email: 'someone-else@example.test' })
    const res = await callAt(env, 'https://api.hushvault.dev/api/admin/orgs', {
      token,
      headers: { 'cf-access-jwt-assertion': accessToken },
    })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'FORBIDDEN' })
  })

  it('allows a valid Access JWT matching the signed-in platform admin (happy path through all four middlewares)', async () => {
    const env = withAccess()
    const { token } = await seedPlatformAdmin(env, 'Admin@Example.test') // mixed case on the account
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    const accessToken = await makeAccessToken(key, { email: 'admin@example.test' }) // Access lower-cases
    const res = await callAt(env, 'https://api.hushvault.dev/api/admin/orgs', {
      token,
      headers: { 'cf-access-jwt-assertion': accessToken },
    })
    expect(res.status).toBe(200)
  })
})
