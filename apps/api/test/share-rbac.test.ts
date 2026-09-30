import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedUser } from './helpers/env'

describe('POST /api/share role guard', () => {
  it('403 for viewer, 201 for member/admin/owner', async () => {
    const env = createTestEnv()
    const owner = await seedUser(env, { role: 'owner' })
    const json = { encryptedPayload: 'ciphertext' }

    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const denied = await call(env, 'POST', '/api/share', { token: viewer.token, json })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('FORBIDDEN')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM share_links').first<{ n: number }>()
    expect(n?.n).toBe(0)

    for (const role of ['member', 'admin'] as const) {
      const u = await seedUser(env, { role, orgId: owner.orgId })
      expect((await call(env, 'POST', '/api/share', { token: u.token, json })).status).toBe(201)
    }
    const res = await call(env, 'POST', '/api/share', { token: owner.token, json })
    expect(res.status).toBe(201)
    expect(res.body.data.token).toEqual(expect.any(String))
  })

  it('401 without auth', async () => {
    const env = createTestEnv()
    expect((await call(env, 'POST', '/api/share', { json: { encryptedPayload: 'x' } })).status).toBe(401)
  })
})
