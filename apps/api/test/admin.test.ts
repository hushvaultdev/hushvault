import { describe, expect, it } from 'vitest'
import { createPrefixedId } from '../src/lib/auth'
import { call, createTestEnv, seedUser, type TestEnv } from './helpers/env'

async function seedPlatformAdmin(env: TestEnv) {
  const { userId, token } = await seedUser(env)
  await env.DB.prepare('INSERT INTO platform_admins (user_id, granted_at) VALUES (?, ?)')
    .bind(userId, new Date().toISOString()).run()
  return { userId, token }
}

describe('requirePlatformAdmin', () => {
  it('rejects a signed-in user who is not a platform admin, even an org owner', async () => {
    const env = createTestEnv()
    const { token } = await seedUser(env, { role: 'owner' })
    const res = await call(env, 'GET', '/api/admin/orgs', { token })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('FORBIDDEN')
  })

  it('rejects no credential and a garbage token the same as any other route', async () => {
    const env = createTestEnv()
    expect((await call(env, 'GET', '/api/admin/orgs')).status).toBe(401)
    expect((await call(env, 'GET', '/api/admin/orgs', { token: 'garbage' })).status).toBe(401)
  })

  it('allows a platform admin', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const res = await call(env, 'GET', '/api/admin/orgs', { token })
    expect(res.status).toBe(200)
  })

  it('re-reads on every request: revoking takes effect immediately, not after the token expires', async () => {
    const env = createTestEnv()
    const { userId, token } = await seedPlatformAdmin(env)
    expect((await call(env, 'GET', '/api/admin/orgs', { token })).status).toBe(200)
    await env.DB.prepare('DELETE FROM platform_admins WHERE user_id = ?').bind(userId).run()
    expect((await call(env, 'GET', '/api/admin/orgs', { token })).status).toBe(403)
  })
})

describe('GET /api/admin/orgs', () => {
  it('lists organisations with plan and member count, never a secret value', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId: orgA } = await seedUser(env)
    await seedUser(env, { orgId: orgA })
    const res = await call(env, 'GET', '/api/admin/orgs', { token })
    expect(res.status).toBe(200)
    const found = res.body.data.find((o: { id: string }) => o.id === orgA)
    expect(found).toMatchObject({ plan: 'free', memberCount: 2 })
    expect(JSON.stringify(res.body)).not.toMatch(/sec_|secret/i)
  })

  it('rejects a garbage cursor with 400 rather than silently returning page one', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    await seedUser(env)
    const res = await call(env, 'GET', '/api/admin/orgs?cursor=not-valid-base64!!', { token })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('VALIDATION_ERROR')
  })

  it('rejects a well-formed-looking cursor with no separator', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const res = await call(env, 'GET', `/api/admin/orgs?cursor=${Buffer.from('no-pipe-here').toString('base64url')}`, { token })
    expect(res.status).toBe(400)
  })

  it('paginates with a tie on created_at broken by id: every org appears exactly once across pages', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    // Seed enough orgs, sharing one created_at timestamp, that ADMIN_LIST_LIMIT (50) is exceeded.
    const now = new Date().toISOString()
    const seededIds: string[] = []
    for (let i = 0; i < 55; i += 1) {
      const { orgId } = await seedUser(env)
      await env.DB.prepare('UPDATE organisations SET created_at = ? WHERE id = ?').bind(now, orgId).run()
      seededIds.push(orgId)
    }

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    do {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const res = await call(env, 'GET', `/api/admin/orgs${qs}`, { token })
      expect(res.status).toBe(200)
      for (const row of res.body.data as { id: string }[]) {
        expect(seen.has(row.id)).toBe(false) // never duplicated across pages
        seen.add(row.id)
      }
      cursor = res.body.nextCursor
      pages += 1
      expect(pages).toBeLessThan(10) // guard against an infinite loop if the fix regresses
    } while (cursor)

    for (const id of seededIds) expect(seen.has(id)).toBe(true) // never skipped
  })

  it('round-trips nextCursor correctly across two pages for orgs with distinct timestamps', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    for (let i = 0; i < 52; i += 1) await seedUser(env)

    const first = await call(env, 'GET', '/api/admin/orgs', { token })
    expect(first.status).toBe(200)
    expect(first.body.data).toHaveLength(50)
    expect(first.body.nextCursor).not.toBeNull()

    const second = await call(env, 'GET', `/api/admin/orgs?cursor=${encodeURIComponent(first.body.nextCursor)}`, { token })
    expect(second.status).toBe(200)
    expect(second.body.nextCursor).toBeNull()
    const firstIds = new Set((first.body.data as { id: string }[]).map((o) => o.id))
    for (const row of second.body.data as { id: string }[]) expect(firstIds.has(row.id)).toBe(false)
  })
})

describe('GET /api/admin/orgs/:id', () => {
  it('returns 404 for an organisation that does not exist', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    expect((await call(env, 'GET', `/api/admin/orgs/${createPrefixedId('org')}`, { token })).status).toBe(404)
  })

  it('includes entitlements and usage for a real organisation', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    const res = await call(env, 'GET', `/api/admin/orgs/${orgId}`, { token })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: orgId, plan: 'free', usage: { projectCount: 0, syncTargetCount: 0 } })
    expect(res.body.data.entitlements.maxSyncTargets).toBe(2)
  })

  it('resolves entitlements correctly for each paid plan (regression for the entitlementsForPlan swap, #112)', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    for (const plan of ['pro', 'team', 'enterprise'] as const) {
      const { orgId } = await seedUser(env)
      await env.DB.prepare('UPDATE organisations SET plan = ? WHERE id = ?').bind(plan, orgId).run()
      const res = await call(env, 'GET', `/api/admin/orgs/${orgId}`, { token })
      expect(res.status).toBe(200)
      expect(res.body.data.entitlements.plan).toBe(plan)
    }
  })
})

describe('PUT /api/admin/orgs/:id/plan', () => {
  it('sets a plan with no expiry and audits the change', async () => {
    const env = createTestEnv()
    const { userId: adminId, token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    const res = await call(env, 'PUT', `/api/admin/orgs/${orgId}/plan`, { token, json: { plan: 'team' } })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: orgId, plan: 'team', planExpiresAt: null })
    const row = await env.DB.prepare('SELECT plan, plan_expires_at FROM organisations WHERE id = ?').bind(orgId)
      .first<{ plan: string; plan_expires_at: string | null }>()
    expect(row).toEqual({ plan: 'team', plan_expires_at: null })
    const audit = await env.DB.prepare('SELECT action, actor_id, org_id, metadata FROM audit_log WHERE action = ?')
      .bind('admin.org.plan_set').first<{ action: string; actor_id: string; org_id: string; metadata: string }>()
    expect(audit).toMatchObject({ actor_id: adminId, org_id: orgId })
    expect(JSON.parse(audit!.metadata)).toEqual({ from: 'free', to: 'team' })
  })

  it('clears a prior comp expiry: setting the plan directly is not a time-boxed grant', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    await env.DB.prepare("UPDATE organisations SET plan = 'pro', plan_expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 1000).toISOString(), orgId).run()
    await call(env, 'PUT', `/api/admin/orgs/${orgId}/plan`, { token, json: { plan: 'pro' } })
    const row = await env.DB.prepare('SELECT plan_expires_at FROM organisations WHERE id = ?').bind(orgId).first<{ plan_expires_at: string | null }>()
    expect(row?.plan_expires_at).toBeNull()
  })

  it('rejects an unknown plan string and 404s a missing organisation', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    expect((await call(env, 'PUT', `/api/admin/orgs/${orgId}/plan`, { token, json: { plan: 'ultra' } })).status).toBe(400)
    expect((await call(env, 'PUT', `/api/admin/orgs/${createPrefixedId('org')}/plan`, { token, json: { plan: 'pro' } })).status).toBe(404)
  })
})

describe('POST /api/admin/orgs/:id/comp', () => {
  it('grants a time-boxed plan and audits it', async () => {
    const env = createTestEnv()
    const { userId: adminId, token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    const before = Date.now()
    const res = await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'pro', days: 60 } })
    expect(res.status).toBe(201)
    expect(res.body.data.plan).toBe('pro')
    const expiresAt = new Date(res.body.data.planExpiresAt).getTime()
    expect(expiresAt).toBeGreaterThan(before + 59 * 86_400_000)
    expect(expiresAt).toBeLessThan(before + 61 * 86_400_000)
    const audit = await env.DB.prepare('SELECT actor_id, metadata FROM audit_log WHERE action = ?')
      .bind('admin.org.comp_grant').first<{ actor_id: string; metadata: string }>()
    expect(audit?.actor_id).toBe(adminId)
    expect(JSON.parse(audit!.metadata)).toEqual({ from: 'free', to: 'pro', days: 60 })
  })

  it('granting again replaces the prior grant rather than stacking', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'pro', days: 90 } })
    const res = await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'team', days: 30 } })
    const row = await env.DB.prepare('SELECT plan, plan_expires_at FROM organisations WHERE id = ?').bind(orgId)
      .first<{ plan: string; plan_expires_at: string }>()
    expect(row?.plan).toBe('team')
    expect(new Date(row!.plan_expires_at).getTime()).toBeCloseTo(new Date(res.body.data.planExpiresAt).getTime(), -2)
  })

  it('rejects granting a comp of "free" and an out-of-range day count', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    expect((await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'free', days: 30 } })).status).toBe(400)
    expect((await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'pro', days: 0 } })).status).toBe(400)
    expect((await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'pro', days: 400 } })).status).toBe(400)
  })
})

describe('DELETE /api/admin/orgs/:id/comp', () => {
  it('revokes an active comp immediately, data kept, and audits it', async () => {
    const env = createTestEnv()
    const { userId: adminId, token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    await call(env, 'POST', `/api/admin/orgs/${orgId}/comp`, { token, json: { plan: 'team', days: 60 } })
    const res = await call(env, 'DELETE', `/api/admin/orgs/${orgId}/comp`, { token })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: orgId, plan: 'free', planExpiresAt: null })
    const audit = await env.DB.prepare('SELECT actor_id, metadata FROM audit_log WHERE action = ?')
      .bind('admin.org.comp_revoke').first<{ actor_id: string; metadata: string }>()
    expect(audit?.actor_id).toBe(adminId)
    expect(JSON.parse(audit!.metadata)).toEqual({ from: 'team' })
  })

  it('is a no-op when the plan has no expiry (nothing to revoke), and 404s a missing organisation', async () => {
    const env = createTestEnv()
    const { token } = await seedPlatformAdmin(env)
    const { orgId } = await seedUser(env)
    await call(env, 'PUT', `/api/admin/orgs/${orgId}/plan`, { token, json: { plan: 'enterprise' } })
    const res = await call(env, 'DELETE', `/api/admin/orgs/${orgId}/comp`, { token })
    expect(res.status).toBe(200)
    expect(res.body.data.plan).toBe('enterprise')
    expect((await call(env, 'DELETE', `/api/admin/orgs/${createPrefixedId('org')}/comp`, { token })).status).toBe(404)
  })
})
