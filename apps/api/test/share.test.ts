import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedUser } from './helpers/env'

const HOUR = 3600_000

async function setup(envOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv(envOverrides)
  const owner = await seedUser(env, { role: 'owner' })
  const create = (json: Record<string, unknown> = {}) =>
    call(env, 'POST', '/api/share', { token: owner.token, json: { encryptedPayload: 'cipher', ...json } })
  return { env, owner, create }
}

describe('share links', () => {
  it('create then fetch roundtrip, with no-store', async () => {
    const { env, create } = await setup()
    const created = await create({ encryptedPayload: 'abc123', maxViews: 3 })
    expect(created.status).toBe(201)
    const res = await call(env, 'GET', `/api/share/${created.body.data.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.encryptedPayload).toBe('abc123')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('maxViews=1: second fetch is 404', async () => {
    const { env, create } = await setup()
    const { token } = (await create()).body.data
    expect((await call(env, 'GET', `/api/share/${token}`)).status).toBe(200)
    expect((await call(env, 'GET', `/api/share/${token}`)).status).toBe(404)
  })

  it('concurrent fetches never exceed maxViews', async () => {
    const { env, create } = await setup()
    const { token } = (await create({ maxViews: 2 })).body.data
    const results = await Promise.all(Array.from({ length: 5 }, () => call(env, 'GET', `/api/share/${token}`)))
    expect(results.filter((r) => r.status === 200)).toHaveLength(2)
    expect(results.filter((r) => r.status === 404)).toHaveLength(3)
    const row = await env.DB.prepare('SELECT view_count FROM share_links WHERE token = ?').bind(token).first<{ view_count: number }>()
    expect(row?.view_count).toBe(2)
  })

  it('expired and missing links return the identical 404 body', async () => {
    const { env, create } = await setup()
    const { token } = (await create()).body.data
    await env.DB.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), token).run()
    const expired = await call(env, 'GET', `/api/share/${token}`)
    const missing = await call(env, 'GET', '/api/share/tok_doesnotexist')
    expect(expired.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(expired.body).toEqual(missing.body)
    expect(expired.body.message).toBe('Share link unavailable')
  })

  it('url host follows WEB_APP_URL and environment', async () => {
    const a = await setup({ WEB_APP_URL: 'https://app.example.test/' })
    const ua = (await a.create()).body.data
    expect(ua.url).toBe(`https://app.example.test/share/${ua.token}`)

    const b = await setup()
    expect((await b.create()).body.data.url).toMatch(/^http:\/\/localhost:3000\/share\/tok_/)

    const c = await setup({ ENVIRONMENT: 'production' })
    expect((await c.create()).body.data.url).toMatch(/^https:\/\/hushvault\.dev\/share\/tok_/)
  })

  it('validates expiresAt: future and at most 7 days', async () => {
    const { env, create } = await setup()
    const past = await create({ expiresAt: new Date(Date.now() - HOUR).toISOString() })
    expect(past.status).toBe(400)
    expect(past.body.error).toBe('VALIDATION_ERROR')
    const far = await create({ expiresAt: new Date(Date.now() + 8 * 24 * HOUR).toISOString() })
    expect(far.status).toBe(400)
    expect(far.body.error).toBe('VALIDATION_ERROR')
    expect((await create({ expiresAt: new Date(Date.now() + 6 * 24 * HOUR).toISOString() })).status).toBe(201)

    const def = (await create()).body.data.token
    const row = await env.DB.prepare('SELECT expires_at FROM share_links WHERE token = ?').bind(def).first<{ expires_at: string }>()
    const delta = new Date(row?.expires_at ?? 0).getTime() - Date.now()
    expect(delta).toBeGreaterThan(HOUR - 60_000)
    expect(delta).toBeLessThanOrEqual(HOUR)
  })

  it('audits share.access without the token', async () => {
    const { env, owner, create } = await setup()
    const { token } = (await create()).body.data
    await call(env, 'GET', `/api/share/${token}`)
    const rows = (await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'share.access'").all<Record<string, unknown>>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['org_id']).toBe(owner.orgId)
    expect(rows[0]?.['actor_type']).toBe('system')
    expect(JSON.stringify(rows)).not.toContain(token)
    const all = (await env.DB.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>()).results
    expect(JSON.stringify(all)).not.toContain(token)
  })

  it('viewer cannot create', async () => {
    const { env, owner } = await setup()
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const res = await call(env, 'POST', '/api/share', { token: viewer.token, json: { encryptedPayload: 'x' } })
    expect(res.status).toBe(403)
  })
})
