import { describe, expect, it } from 'vitest'
import {
  AUDIT_SWEEP_ROWS_PER_TICK,
  ORPHAN_CANDIDATE_TTL_MS,
  ORPHAN_DELETE_PER_TICK,
  ORPHAN_GRACE_MS,
  ORPHAN_SCAN_KEYS_PER_TICK,
  housekeepingTick,
} from '../src/lib/housekeeping'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { seedSecret } from './helpers/env-secrets'

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

// Issue #87. The create and update paths write KV before D1 commits and the delete path
// removes D1 rows first, so both leave blobs nothing points at. Nothing collected them and
// nothing could even count them.
describe('orphaned KV blob reconciliation', () => {
  const T0 = new Date('2026-10-05T00:00:00.000Z')
  const at = (ms: number) => new Date(T0.getTime() + ms)
  /** Comfortably past the grace period, nowhere near the candidate TTL. */
  const AFTER_GRACE = ORPHAN_GRACE_MS + 60_000

  async function scene() {
    const env = createTestEnv()
    const owner = await seedUser(env, { role: 'owner' })
    const projectId = await seedProject(env, owner.orgId)
    const envId = await seedEnvironment(env, projectId, 'prod')
    return { env, owner, projectId, envId }
  }

  const blobs = (env: TestEnv) => [...env.SECRETS_KV.store.keys()].filter((k) => k.startsWith('secret:')).sort()
  const candidates = async (env: TestEnv) =>
    (await env.DB.prepare('SELECT kv_key FROM orphan_blob_candidates ORDER BY kv_key').all<{ kv_key: string }>())
      .results.map((r) => r.kv_key)

  it('deletes a blob left by a failed create, but only after the grace period', async () => {
    const { env } = await scene()
    env.SECRETS_KV.store.set('secret:sec_orphan:1', 'CIPHERTEXT')

    // First sighting: recorded, never deleted.
    const first = await housekeepingTick(env, T0)
    expect(first).toMatchObject({ orphanBlobsScanned: 1, orphanBlobsUnreferenced: 1, orphanBlobsDeleted: 0 })
    expect(blobs(env)).toEqual(['secret:sec_orphan:1'])
    expect(await candidates(env)).toEqual(['secret:sec_orphan:1'])

    // Still inside the grace period.
    expect((await housekeepingTick(env, at(ORPHAN_GRACE_MS - 1))).orphanBlobsDeleted).toBe(0)
    expect(blobs(env)).toEqual(['secret:sec_orphan:1'])

    // Past it: gone, and the candidate row goes with it.
    expect((await housekeepingTick(env, at(AFTER_GRACE))).orphanBlobsDeleted).toBe(1)
    expect(blobs(env)).toEqual([])
    expect(await candidates(env)).toEqual([])
  })

  // The one that matters: a blob whose D1 row is written between the two sightings belongs to
  // a live secret, and the sweep must notice and leave it alone.
  it('never deletes a blob whose row was written concurrently', async () => {
    const { env, projectId, envId } = await scene()
    env.SECRETS_KV.store.set('secret:sec_inflight:1', 'CIPHERTEXT')

    // Tick 1: the request that wrote the blob has not committed D1 yet.
    expect((await housekeepingTick(env, T0)).orphanBlobsUnreferenced).toBe(1)
    expect(await candidates(env)).toEqual(['secret:sec_inflight:1'])

    // The request commits.
    const now = T0.toISOString()
    await env.DB.prepare(
      'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, enc_version, blob_rev, is_computed, dependencies, created_at, updated_at)'
      + " VALUES (?, ?, ?, 'INFLIGHT', 'wrapped', 'v1', 2, 1, 0, '[]', ?, ?)",
    ).bind('sec_inflight', projectId, envId, now, now).run()

    // Tick 2, long past the grace period: the blob is referenced, so it survives and stops
    // being a candidate. This is the failure mode that would corrupt a live secret.
    const second = await housekeepingTick(env, at(AFTER_GRACE))
    expect(second).toMatchObject({ orphanBlobsScanned: 1, orphanBlobsUnreferenced: 0, orphanBlobsDeleted: 0 })
    expect(env.SECRETS_KV.store.get('secret:sec_inflight:1')).toBe('CIPHERTEXT')
    expect(await candidates(env)).toEqual([])

    // And it stays safe however long the sweep runs.
    await housekeepingTick(env, at(AFTER_GRACE * 2))
    await housekeepingTick(env, at(AFTER_GRACE * 3))
    expect(env.SECRETS_KV.store.get('secret:sec_inflight:1')).toBe('CIPHERTEXT')
  })

  it('leaves every revision a live row could still reference', async () => {
    const { env, owner, projectId, envId } = await scene()
    const created = await call(env, 'POST', '/api/secrets', {
      token: owner.token,
      json: { projectId, envId, name: 'API_KEY', value: 'one' },
    })
    expect(created.status).toBe(201)
    const id = created.body.data.id
    // Two value changes: rev 1 and 2 are referenced by history rows, rev 3 is current.
    for (const value of ['two', 'three']) {
      expect((await call(env, 'PATCH', `/api/secrets/${id}`, { token: owner.token, json: { value } })).status).toBe(200)
    }
    const live = blobs(env)
    expect(live).toEqual([`secret:${id}:1`, `secret:${id}:2`, `secret:${id}:3`])

    // A blob above the pointer: what a failed update leaves behind.
    env.SECRETS_KV.store.set(`secret:${id}:4`, 'ORPHANED_BY_FAILED_UPDATE')

    const result = await housekeepingTick(env, T0)
    expect(result.orphanBlobsUnreferenced).toBe(1)
    expect(await candidates(env)).toEqual([`secret:${id}:4`])

    expect((await housekeepingTick(env, at(AFTER_GRACE))).orphanBlobsDeleted).toBe(1)
    expect(blobs(env)).toEqual(live)
    // The secret still reads back.
    const read = await call(env, 'GET', `/api/environments/${envId}/resolved?values=true`, { token: owner.token })
    expect(read.body.data.secrets.map((s: { value: string }) => s.value)).toEqual(['three'])
  })

  it('collects the blobs a delete left behind when its KV deletes did not finish', async () => {
    const { env, owner, projectId, envId } = await scene()
    const created = await call(env, 'POST', '/api/secrets', {
      token: owner.token,
      json: { projectId, envId, name: 'GONE', value: 'x' },
    })
    const id = created.body.data.id
    // D1 row removed, KV delete never happened (the subrequest ceiling, a KV error).
    await env.DB.prepare('DELETE FROM secrets WHERE id = ?').bind(id).run()
    expect(blobs(env)).toEqual([`secret:${id}:1`])

    await housekeepingTick(env, T0)
    expect((await housekeepingTick(env, at(AFTER_GRACE))).orphanBlobsDeleted).toBe(1)
    expect(blobs(env)).toEqual([])
  })

  it('leaves alone anything under the prefix it did not write', async () => {
    const { env } = await scene()
    for (const key of ['secret:', 'secret::1', 'secret:sec_a:0', 'secret:sec_a:01', 'secret:sec_a:1:2']) {
      env.SECRETS_KV.store.set(key, 'NOT OURS')
    }
    env.SECRETS_KV.store.set('secrethist:sech_1', 'PRE-0014 HISTORY COPY')
    env.SECRETS_KV.store.set('jwks:https://example.test', 'CACHE')

    for (const now of [T0, at(AFTER_GRACE), at(AFTER_GRACE * 2)]) {
      const result = await housekeepingTick(env, now)
      expect(result.orphanBlobsScanned).toBe(0)
      expect(result.orphanBlobsDeleted).toBe(0)
    }
    expect(env.SECRETS_KV.store.size).toBe(7)
  })

  it('is bounded per tick and resumes where it stopped', async () => {
    const { env } = await scene()
    const total = ORPHAN_SCAN_KEYS_PER_TICK + 25
    for (let i = 0; i < total; i += 1) {
      env.SECRETS_KV.store.set(`secret:sec_${String(i).padStart(4, '0')}:1`, 'C')
    }

    // One page per tick, then the remainder, then back to the start.
    expect((await housekeepingTick(env, T0)).orphanBlobsScanned).toBe(ORPHAN_SCAN_KEYS_PER_TICK)
    expect(await candidates(env)).toHaveLength(ORPHAN_SCAN_KEYS_PER_TICK)
    expect((await housekeepingTick(env, T0)).orphanBlobsScanned).toBe(25)
    expect(await candidates(env)).toHaveLength(total)
    expect((await housekeepingTick(env, T0)).orphanBlobsScanned).toBe(ORPHAN_SCAN_KEYS_PER_TICK)

    // Deletes are bounded separately, and more tightly, because each is a subrequest. Without
    // the bound a full page would delete all 200 of its keys at once.
    const counts: number[] = []
    for (let i = 0; i < 40; i += 1) {
      counts.push((await housekeepingTick(env, at(AFTER_GRACE + i))).orphanBlobsDeleted)
    }
    expect(counts.every((n) => n <= ORPHAN_DELETE_PER_TICK)).toBe(true)
    expect(Math.max(...counts)).toBe(ORPHAN_DELETE_PER_TICK)

    // And it converges: the backlog clears and nothing is left behind.
    expect(blobs(env)).toEqual([])
    expect(await candidates(env)).toEqual([])
  })

  it('forgets a candidate whose blob has since gone, so the table stays bounded', async () => {
    const { env } = await scene()
    env.SECRETS_KV.store.set('secret:sec_vanishing:1', 'C')
    await housekeepingTick(env, T0)
    expect(await candidates(env)).toEqual(['secret:sec_vanishing:1'])

    // The normal delete path removes the blob before the sweep gets back to it.
    env.SECRETS_KV.store.delete('secret:sec_vanishing:1')
    await housekeepingTick(env, at(AFTER_GRACE))
    expect(await candidates(env)).toEqual(['secret:sec_vanishing:1']) // still waiting, unseen

    await housekeepingTick(env, at(ORPHAN_CANDIDATE_TTL_MS + 1))
    expect(await candidates(env)).toEqual([])
  })

  it('reports a KV failure as not-deleted and retries it next tick', async () => {
    const { env } = await scene()
    env.SECRETS_KV.store.set('secret:sec_stubborn:1', 'C')
    await housekeepingTick(env, T0)

    const real = env.SECRETS_KV.delete.bind(env.SECRETS_KV)
    let fail = true
    env.SECRETS_KV.delete = async (key: string) => {
      if (fail) throw new Error('KV unavailable')
      return real(key)
    }
    expect((await housekeepingTick(env, at(AFTER_GRACE))).orphanBlobsDeleted).toBe(0)
    expect(await candidates(env)).toEqual(['secret:sec_stubborn:1']) // not forgotten

    fail = false
    expect((await housekeepingTick(env, at(AFTER_GRACE + 1))).orphanBlobsDeleted).toBe(1)
    expect(blobs(env)).toEqual([])
  })

  it('does not take the other sweeps down when migration 0016 is missing', async () => {
    const { env, owner } = await scene()
    env.SECRETS_KV.store.set('secret:sec_orphan:1', 'C')
    await seedAudit(env, owner.orgId, 3, 30)
    env.DB.sqlite.exec('DROP TABLE orphan_blob_candidates')

    const result = await housekeepingTick(env, T0)
    expect(result.auditRowsDeleted).toBe(3) // the step that failed did not skip the others
    expect(result.orphanBlobsDeleted).toBe(0)
    expect(blobs(env)).toEqual(['secret:sec_orphan:1'])
  })

  it('never logs a blob key, a value or a wrapped DEK', async () => {
    const { env, owner, projectId, envId } = await scene()
    const id = await seedSecret(env, projectId, envId, 'LIVE', 'the-plaintext-value')
    env.SECRETS_KV.store.set('secret:sec_orphan:1', 'ORPHAN_CIPHERTEXT')
    const wrapped = (await env.DB.prepare('SELECT wrapped_dek AS w FROM secrets WHERE id = ?').bind(id)
      .first<{ w: string }>())!.w

    const logs: string[] = []
    const realLog = console.log
    console.log = (m: unknown) => { logs.push(String(m)) }
    try {
      await housekeepingTick(env, T0)
      await housekeepingTick(env, at(AFTER_GRACE))
    } finally {
      console.log = realLog
    }

    const haystack = logs.join('\n')
    expect(haystack).toContain('housekeeping.orphan_blobs')
    expect(haystack).toContain('"deleted":1')
    for (const needle of ['the-plaintext-value', 'ORPHAN_CIPHERTEXT', wrapped, 'sec_orphan', id, owner.orgId]) {
      expect(haystack).not.toContain(needle)
    }
  })
})
