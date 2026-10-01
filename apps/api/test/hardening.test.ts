import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { assertSecretSize, redactPath, SecretTooLargeError } from '../src/lib/security'
import { call, createTestEnv, seedApiKey, seedUser } from './helpers/env'

app.get('/__test/too-large', () => { assertSecretSize('x'.repeat(70_000)) })
app.get('/__test/boom', () => { throw new Error('kaboom') })

afterEach(() => vi.restoreAllMocks())

function lastKeyRow(env: ReturnType<typeof createTestEnv>, id: string) {
  return env.DB.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').bind(id).first<{ last_used_at: string | null }>()
}

describe('api key last_used_at throttle', () => {
  it('writes when null, skips when recent, writes when stale', async () => {
    const env = createTestEnv()
    const { userId } = await seedUser(env)
    const { id, rawKey } = await seedApiKey(env, userId)

    expect((await call(env, 'GET', '/api/projects', { token: rawKey })).status).toBe(200)
    const first = (await lastKeyRow(env, id))?.last_used_at
    expect(first).toBeTruthy()

    await call(env, 'GET', '/api/projects', { token: rawKey })
    expect((await lastKeyRow(env, id))?.last_used_at).toBe(first)

    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(old, id).run()
    await call(env, 'GET', '/api/projects', { token: rawKey })
    const updated = (await lastKeyRow(env, id))?.last_used_at
    expect(updated).not.toBe(old)
  })

  it('still rejects revoked keys', async () => {
    const env = createTestEnv()
    const { userId } = await seedUser(env)
    const { id, rawKey } = await seedApiKey(env, userId)
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run()
    expect((await call(env, 'GET', '/api/projects', { token: rawKey })).status).toBe(401)
  })
})

describe('onError + request logging', () => {
  it('returns requestId and logs neither query, body nor secret', async () => {
    const env = createTestEnv()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await app.request('/__test/boom?token=abc', {
      method: 'GET',
      headers: { 'x-secret': 'TOPSECRETVALUE' },
    }, env)
    const body = await res.json() as any
    expect(res.status).toBe(500)
    expect(body).toMatchObject({ error: 'INTERNAL_ERROR', message: 'Something went wrong' })
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'))
    expect(err).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(err.mock.calls[0]?.[0]))
    expect(line).toMatchObject({ level: 'error', requestId: body.requestId, method: 'GET', path: '/__test/boom', status: 500, errorName: 'Error', errorMessage: 'kaboom' })
    const all = JSON.stringify([err.mock.calls, log.mock.calls])
    expect(all).not.toContain('token=abc')
    expect(all).not.toContain('TOPSECRETVALUE')
  })

  it('does not log POST body on a real forced 500', async () => {
    const env = createTestEnv()
    const { token } = await seedUser(env)
    env.DB.prepare = () => { throw new Error('db exploded') }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/api/projects?token=abc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SUPERSECRETBODY' }),
    }, env)
    expect(res.status).toBe(500)
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/SUPERSECRETBODY|token=abc/)
  })

  it('maps SecretTooLargeError to 400 VALIDATION_ERROR', async () => {
    expect(() => assertSecretSize('x'.repeat(70_000))).toThrow(SecretTooLargeError)
    const res = await app.request('/__test/too-large', {}, createTestEnv())
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('VALIDATION_ERROR')
  })

  it('redacts share tokens and query strings in the request log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await app.request('/api/share/SHARETOKEN123?x=1', {}, createTestEnv({ ENVIRONMENT: 'development' }))
    const out = JSON.stringify(log.mock.calls)
    expect(out).not.toContain('SHARETOKEN123')
    expect(out).not.toContain('x=1')
    const line = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(line).toMatchObject({ method: 'GET', path: '/api/share/:token' })
    expect(typeof line.status).toBe('number')
    expect(typeof line.durationMs).toBe('number')
    expect(redactPath('/api/share/abc/def?q=1')).toBe('/api/share/:token/def')
  })
})

describe('CORS', () => {
  const preflight = (env: ReturnType<typeof createTestEnv>, origin: string) =>
    app.request('/api/projects', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }, env)

  it('excludes localhost in production', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'production' })
    expect((await preflight(env, 'http://localhost:3000')).headers.get('access-control-allow-origin')).toBeNull()
    expect((await preflight(env, 'https://hushvault.dev')).headers.get('access-control-allow-origin')).toBe('https://hushvault.dev')
    // The dev dashboard must not be trusted by a production API.
    expect((await preflight(env, 'https://beta.hushvault.dev')).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows localhost outside production', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'development' })
    expect((await preflight(env, 'http://localhost:3000')).headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  it('trusts the origin of the configured WEB_APP_URL, and only that origin', async () => {
    const env = createTestEnv({ ENVIRONMENT: 'production', WEB_APP_URL: 'https://hushvault-web-dev.example.workers.dev/some/path' })
    expect((await preflight(env, 'https://hushvault-web-dev.example.workers.dev')).headers.get('access-control-allow-origin')).toBe('https://hushvault-web-dev.example.workers.dev')
    expect((await preflight(env, 'https://evil.example.workers.dev')).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('ignores an unset or malformed WEB_APP_URL', async () => {
    for (const WEB_APP_URL of [undefined, 'not a url']) {
      const env = createTestEnv({ ENVIRONMENT: 'production', WEB_APP_URL })
      expect((await preflight(env, 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})
