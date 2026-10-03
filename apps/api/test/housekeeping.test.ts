import { describe, expect, it } from 'vitest'
import { AUDIT_SWEEP_ROWS_PER_TICK, housekeepingTick } from '../src/lib/housekeeping'
import { call, createTestEnv, seedUser, type TestEnv } from './helpers/env'

async function seedAudit(env: TestEnv, orgId: string, count: number, daysAgo: number) {
  const ts = new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString()
  for (let i = 0; i < count; i += 1) {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, org_id, actor_id, actor_type, action, timestamp) VALUES (?, ?, NULL, 'system', 'secret.read', ?)",
    ).bind(`aud_${daysAgo}_${i}`, orgId, ts).run()
  }
}

const countAudit = (env: TestEnv, orgId: string) =>
  env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').bind(orgId).first<{ n: number }>()

describe('audit retention sweep', () => {
  it('deletes rows outside the plan window and keeps the ones inside it', async () => {
    const env = createTestEnv()
    const { orgId } = await seedUser(env) // free plan: 7 days
    await seedAudit(env, orgId, 3, 30)
    await seedAudit(env, orgId, 2, 1)
    expect((await countAudit(env, orgId))?.n).toBe(5)

    const result = await housekeepingTick(env)
    expect(result.auditRowsDeleted).toBe(3)
    expect((await countAudit(env, orgId))?.n).toBe(2)
  })

  it('never deletes for a plan that retains forever', async () => {
    const env = createTestEnv()
    const { orgId } = await seedUser(env)
    await env.DB.prepare("UPDATE organisations SET plan = 'enterprise' WHERE id = ?").bind(orgId).run()
    await seedAudit(env, orgId, 4, 400)

    expect((await housekeepingTick(env)).auditRowsDeleted).toBe(0)
    expect((await countAudit(env, orgId))?.n).toBe(4)
  })

  // The per-organisation override narrows what the API shows. If it also deleted, an admin could
  // permanently destroy the trail of their own actions with one call — the opposite of the point.
  it('ignores the per-organisation override, which is display-only', async () => {
    const env = createTestEnv()
    const { orgId } = await seedUser(env)
    await env.DB.prepare('UPDATE organisations SET audit_retention_days = 1 WHERE id = ?').bind(orgId).run()
    await seedAudit(env, orgId, 3, 3) // inside the 7-day plan window, outside the 1-day override

    expect((await housekeepingTick(env)).auditRowsDeleted).toBe(0)
    expect((await countAudit(env, orgId))?.n).toBe(3)
  })

  it('is bounded per tick and resumes on the next one', async () => {
    const env = createTestEnv()
    const { orgId } = await seedUser(env)
    await seedAudit(env, orgId, AUDIT_SWEEP_ROWS_PER_TICK + 10, 30)

    expect((await housekeepingTick(env)).auditRowsDeleted).toBe(AUDIT_SWEEP_ROWS_PER_TICK)
    expect((await housekeepingTick(env)).auditRowsDeleted).toBe(10)
    expect((await countAudit(env, orgId))?.n).toBe(0)
  })
})

describe('share link purge', () => {
  it('removes expired and fully viewed links, with their ciphertext', async () => {
    const env = createTestEnv()
    const { token, orgId } = await seedUser(env, { role: 'member', emailVerified: true })

    const live = await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'LIVE' } })
    expect(live.status).toBe(201)
    const used = await call(env, 'POST', '/api/share', { token, json: { encryptedPayload: 'USED', maxViews: 1 } })
    await call(env, 'GET', `/api/share/${used.body.data.token}`)

    await env.DB.prepare('INSERT INTO share_links (id, token, encrypted_payload, expires_at, max_views, view_count, org_id, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
      .bind('sh_old', 'tok_old', 'EXPIRED', new Date(Date.now() - 3600_000).toISOString(), orgId, new Date().toISOString()).run()

    expect((await housekeepingTick(env)).shareLinksDeleted).toBe(2)
    const left = await env.DB.prepare('SELECT encrypted_payload AS p FROM share_links').all<{ p: string }>()
    expect((left.results ?? []).map((r) => r.p)).toEqual(['LIVE'])
  })
})
