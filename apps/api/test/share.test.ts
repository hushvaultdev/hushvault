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

describe('share link ownership, listing and revocation', () => {
  it('refuses to deliver a link that has no organisation to audit against', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'member', emailVerified: true })
    const created = await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'CIPHERTEXT' } })
    expect(created.status).toBe(201)

    // The pre-0015 state: created_by nulled by a user deletion, no owning organisation.
    await env.DB.prepare('UPDATE share_links SET org_id = NULL, created_by = NULL').run()

    const got = await call(env, 'GET', `/api/share/${created.body.data.token}`)
    expect(got.status).toBe(404)
    expect(got.body).toEqual({ error: 'NOT_FOUND', message: 'Share link unavailable' })

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'share.access' AND org_id = ?")
      .bind(orgId).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('records the access against the organisation that created it', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'member', emailVerified: true })
    const created = await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'CIPHERTEXT' } })
    expect((await call(env, 'GET', `/api/share/${created.body.data.token}`)).status).toBe(200)

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'share.access' AND org_id = ?")
      .bind(orgId).first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('lists live links without the payload or the token, admin only', async () => {
    const env = createTestEnv()
    const admin = await seedUser(env, { role: 'admin', emailVerified: true })
    const member = await seedUser(env, { role: 'member', orgId: admin.orgId, emailVerified: true })
    await call(env, 'POST', '/api/share', { token: member.token, json: { encryptedPayload: 'CIPHERTEXT' } })

    expect((await call(env, 'GET', '/api/share', { token: member.token })).status).toBe(403)

    const list = await call(env, 'GET', '/api/share', { token: admin.token })
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toContain('CIPHERTEXT')
    expect(JSON.stringify(list.body)).not.toContain('tok_')
    expect(list.body.data[0]).toMatchObject({ createdBy: member.userId, maxViews: 1, viewCount: 0 })
  })

  it('revokes a link so the URL stops working, and refuses another organisation', async () => {
    const env = createTestEnv()
    const mine = await seedUser(env, { role: 'member', emailVerified: true })
    const other = await seedUser(env, { role: 'member', emailVerified: true })
    const created = await call(env, 'POST', '/api/share', { token: mine.token, json: { encryptedPayload: 'CIPHERTEXT' } })
    const id = (await env.DB.prepare('SELECT id FROM share_links LIMIT 1').first<{ id: string }>())?.id as string

    expect((await call(env, 'DELETE', `/api/share/${id}`, { token: other.token })).status).toBe(404)
    expect((await call(env, 'GET', `/api/share/${created.body.data.token}`)).status).toBe(200)

    const second = await call(env, 'POST', '/api/share', { token: mine.token, json: { encryptedPayload: 'AGAIN', maxViews: 5 } })
    const secondId = (await env.DB.prepare("SELECT id FROM share_links WHERE encrypted_payload = 'AGAIN'").first<{ id: string }>())?.id as string
    expect((await call(env, 'DELETE', `/api/share/${secondId}`, { token: mine.token })).status).toBe(200)
    expect((await call(env, 'GET', `/api/share/${second.body.data.token}`)).status).toBe(404)

    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM share_links WHERE encrypted_payload = 'AGAIN'").first<{ n: number }>()
    expect(left?.n).toBe(0)
  })
})
