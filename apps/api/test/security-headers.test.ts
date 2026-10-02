import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser } from './helpers/env'

describe('security headers', () => {
  it('sets the fixed hardening headers on every response', async () => {
    const env = createTestEnv()
    const res = await call(env, 'GET', '/')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })

  // A response carrying a plaintext secret value must never be storable by a browser
  // cache or a shared corporate proxy.
  it('marks plaintext read paths no-store', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env)
    const projectId = await seedProject(env, orgId)
    const envId = await seedEnvironment(env, projectId)

    const created = await call(env, 'POST', '/api/secrets', {
      token,
      json: { projectId, envId, name: 'API_KEY', value: 'plaintext-canary' },
    })
    expect(created.status).toBe(201)

    const byName = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token })
    expect(byName.status).toBe(200)
    expect(byName.headers.get('Cache-Control')).toBe('no-store')

    const resolved = await call(env, 'GET', `/api/environments/${envId}/resolved`, { token })
    expect(resolved.status).toBe(200)
    expect(resolved.headers.get('Cache-Control')).toBe('no-store')
  })

  it('marks errors and 404s no-store too', async () => {
    const env = createTestEnv()
    const res = await call(env, 'GET', '/api/secrets/nope')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
