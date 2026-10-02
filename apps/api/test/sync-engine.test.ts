import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeFingerprint,
  computeNextRetryAt,
  computeRetryDelayMs,
  isReservedSyncName,
  loadSyncTarget,
  MAX_SYNC_ATTEMPTS,
  planSync,
  previewSync,
  runSync,
  SyncEngineError,
  SYNC_LEASE_MS,
} from '../src/integrations/sync-engine'
import { auditActions } from './helpers/projects-seed'
import { createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { CREDENTIAL, installFakeProvider, seedComputed, seedConnection, seedSecret, seedTarget, setupSyncWorld, type FakeProvider } from './helpers/sync-fixture'

const CANARY = 'canary-VALUE-7c2f19d0-must-never-leak'

let env: TestEnv
let provider: FakeProvider
let logged: string[]

beforeEach(() => {
  env = createTestEnv()
  provider = installFakeProvider()
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

async function target(world: { targetId: string }) {
  const t = await loadSyncTarget(env, world.targetId)
  if (!t) throw new Error('target missing')
  return t
}
const ledger = async (targetId: string) =>
  (await env.DB.prepare('SELECT name FROM sync_items WHERE target_id = ? ORDER BY name').bind(targetId).all<{ name: string }>()).results.map((r) => r.name)
const runRow = (id: string) => env.DB.prepare('SELECT * FROM sync_runs WHERE id = ?').bind(id).first<Record<string, unknown>>()

describe('planning', () => {
  it('classifies create / update / skip / conflict and leaves conflicts untouched', async () => {
    const w = await setupSyncWorld(env, { secrets: { A_NEW: 'v1', B_SAME: 'v2', C_CHANGED: 'v3', D_CONFLICT: 'v4' } })
    // First run pushes everything except the conflict (D_CONFLICT is pre-existing on the target).
    provider.remote.set('D_CONFLICT', 'someone-elses')
    const first = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    expect(first).toMatchObject({ status: 'succeeded', counts: { created: 3, updated: 0, deleted: 0, skipped: 1, failed: 0 } })
    expect(provider.remote.get('D_CONFLICT')).toBe('someone-elses')
    expect(await ledger(w.targetId)).toEqual(['A_NEW', 'B_SAME', 'C_CHANGED'])

    // Change one value, add one more.
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'C_CHANGED'").run()
    await seedSecret(env, w.projectId, w.envId, 'C_CHANGED', 'v3-new')
    await seedSecret(env, w.projectId, w.envId, 'E_ADDED', 'v5')
    const planned = await planSync(env, await target(w), provider)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan).toEqual({
      create: ['E_ADDED'], update: ['C_CHANGED'], delete: [], skip: ['A_NEW', 'B_SAME'], conflict: ['D_CONFLICT'], blockers: [],
    })
  })

  it('re-pushes a name HushVault wrote that vanished from the target (drift)', async () => {
    const w = await setupSyncWorld(env)
    await runSync(env, w.targetId, { trigger: 'manual' })
    provider.remote.delete('API_KEY')
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.counts).toMatchObject({ created: 1, skipped: 1 })
    expect(provider.remote.get('API_KEY')).toBe('k-1')
  })

  it('applies the prefix (kept in the target name) and the deny list', async () => {
    const w = await setupSyncWorld(env, { nameFilter: { prefix: 'APP_', deny: ['APP_LOCAL'] }, secrets: { APP_ONE: '1', APP_LOCAL: '2', OTHER: '3' } })
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).toBe('succeeded')
    expect([...provider.remote.keys()]).toEqual(['APP_ONE'])
  })

  it('applies branch inheritance (child overrides parent)', async () => {
    const w = await setupSyncWorld(env, { secrets: { SHARED: 'parent' } })
    const child = await seedEnvironment(env, w.projectId, 'staging', w.envId)
    await seedSecret(env, w.projectId, child, 'SHARED', 'child')
    const childTarget = await seedTarget(env, { orgId: w.orgId, projectId: w.projectId, envId: child, connectionId: w.connectionId })
    await runSync(env, childTarget, { trigger: 'manual' })
    expect(provider.remote.get('SHARED')).toBe('child')
  })

  it('previewSync returns names only', async () => {
    const w = await setupSyncWorld(env, { secrets: { SECRET_ONE: CANARY } })
    const preview = await previewSync(env, w.orgId, w.targetId, { actorId: w.userId })
    expect(preview).toMatchObject({ ok: true, plan: { create: ['SECRET_ONE'] } })
    expect(JSON.stringify(preview)).not.toContain(CANARY)
  })

  it('plan ops never serialise the secret value', async () => {
    const w = await setupSyncWorld(env, { secrets: { SECRET_ONE: CANARY } })
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.ops).toHaveLength(1)
    expect(JSON.stringify(planned)).not.toContain(CANARY)
    expect(JSON.stringify({ ...planned.ops[0] })).not.toContain(CANARY)
  })
})

describe('reserved bootstrap names', () => {
  it('recognises the reserved names', () => {
    for (const n of ['ENCRYPTION_MASTER_KEY', 'ENCRYPTION_KEY_V2', 'ENCRYPTION_KEY_V10', 'JWT_SECRET', 'jwt_secret']) expect(isReservedSyncName(n)).toBe(true)
    for (const n of ['ENCRYPTION_KEY', 'MY_JWT_SECRET', 'ENCRYPTION_KEY_VX']) expect(isReservedSyncName(n)).toBe(false)
  })

  it('never pushes them, lists them as skipped, and never deletes them', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { JWT_SECRET: 'j', ENCRYPTION_MASTER_KEY: 'm', ENCRYPTION_KEY_V2: 'k', REAL: 'r' } })
    provider.remote.set('JWT_SECRET', 'on-target-already')
    const t = await target(w)
    const planned = await planSync(env, t, provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.reserved).toEqual(['ENCRYPTION_KEY_V2', 'ENCRYPTION_MASTER_KEY', 'JWT_SECRET'])
    expect(planned.plan.skip).toEqual(expect.arrayContaining(planned.reserved))
    expect(planned.plan.create).toEqual(['REAL'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).toBe('succeeded')
    expect(provider.pushCalls.flat().map((o) => o.name)).toEqual(['REAL'])
    expect(provider.remote.get('JWT_SECRET')).toBe('on-target-already')
    expect(await ledger(w.targetId)).toEqual(['REAL'])
  })
})

describe('provider limits are validated before any write', () => {
  it('blocks with TOO_MANY_ITEMS / VALUE_TOO_LARGE / NAME_INVALID and makes zero push calls', async () => {
    provider = installFakeProvider({ maxItems: 3, maxNameLength: 8, maxValueBytes: 10 })
    const w = await setupSyncWorld(env, { secrets: { OK_ONE: 'a', OK_TWO: 'b', TOO_LONG_NAME: 'c', BIG: 'x'.repeat(11), 'MULTIé': 'z' } })
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    const codes = Object.fromEntries(planned.plan.blockers.map((b) => [b.code, b.names]))
    expect(codes['NAME_INVALID']).toEqual(['MULTIé', 'TOO_LONG_NAME'])
    expect(codes['VALUE_TOO_LARGE']).toEqual(['BIG'])
    expect(codes['TOO_MANY_ITEMS']).toBeDefined()
    expect(planned.plan.create).not.toContain('BIG')

    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_VALIDATION', nextRetryAt: null })
    expect(provider.pushCalls).toHaveLength(0)
    expect((await target(w)).status).toBe('needs_attention')
    expect(await ledger(w.targetId)).toEqual([])
  })

  it('chunks operations by limits.maxItems', async () => {
    provider = installFakeProvider({ maxItems: 2 })
    const w = await setupSyncWorld(env, { secrets: { A: '1', B: '2' } })
    // 2 items fit; add a third by raising nothing: use a provider with maxItems 2 and update + delete mix.
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare('UPDATE sync_targets SET delete_removed = 1 WHERE id = ?').bind(w.targetId).run()
    await env.DB.prepare("DELETE FROM secrets WHERE name IN ('A', 'B')").run()
    await seedSecret(env, w.projectId, w.envId, 'C', '3')
    await seedSecret(env, w.projectId, w.envId, 'D', '4')
    provider.pushCalls.length = 0
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'succeeded', counts: { created: 2, deleted: 2 } })
    expect(provider.pushCalls.map((c) => c.length)).toEqual([2, 2])
    // sets are sent before deletes
    expect(provider.pushCalls[0]!.every((o) => o.type === 'set')).toBe(true)
    expect(provider.pushCalls[1]!.every((o) => o.type === 'delete')).toBe(true)
  })
})

describe('partial failure and retry', () => {
  it('records confirmed items, reports partial, and the retry resumes with only the rest', async () => {
    provider = installFakeProvider({ maxItems: 100 })
    const w = await setupSyncWorld(env, { secrets: { A: '1', B: '2', C: '3' } })
    provider.script.push(() => ({ ok: true, results: [{ name: 'A', ok: true }, { name: 'B', ok: false, code: 'PROVIDER_ERROR' }, { name: 'C', ok: true }] }))
    const now = new Date('2026-01-01T00:00:00.000Z')
    const first = await runSync(env, w.targetId, { trigger: 'manual', now, attempt: 1 })
    expect(first).toMatchObject({ status: 'partial', errorCode: 'PROVIDER_ERROR', counts: { created: 2, failed: 1 } })
    expect(first.nextRetryAt).not.toBeNull()
    expect(new Date(first.nextRetryAt!).getTime()).toBeGreaterThan(now.getTime())
    expect(await ledger(w.targetId)).toEqual(['A', 'C'])
    expect((await target(w)).status).toBe('active')

    provider.pushCalls.length = 0
    const second = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(second).toMatchObject({ status: 'succeeded', counts: { created: 1, skipped: 2, failed: 0 } })
    expect(provider.pushCalls.flat().map((o) => o.name)).toEqual(['B'])
    expect(await ledger(w.targetId)).toEqual(['A', 'B', 'C'])
  })

  // maxItems is the target's capacity (TOO_MANY_ITEMS) and the batch size: only set+delete mixes exceed it.
  async function swapWorld() {
    provider = installFakeProvider({ maxItems: 2 })
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { A: '1', B: '2' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name IN ('A', 'B')").run()
    await seedSecret(env, w.projectId, w.envId, 'C', '3')
    await seedSecret(env, w.projectId, w.envId, 'D', '4')
    provider.pushCalls.length = 0
    return w
  }

  it('a chunk-level failure on the first chunk is a failed run and later chunks are not attempted', async () => {
    const w = await swapWorld()
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_RATE_LIMIT' }))
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMIT', counts: { created: 0, deleted: 0, failed: 4 } })
    expect(provider.pushCalls).toHaveLength(1)
    expect(run.nextRetryAt).not.toBeNull()
    expect((await target(w)).status).toBe('active')
    expect(await ledger(w.targetId)).toEqual(['A', 'B'])
  })

  it('a failure after the first chunk keeps the first chunk (partial) and the retry finishes', async () => {
    const w = await swapWorld()
    provider.script.push(() => undefined, () => ({ ok: false, code: 'PROVIDER_ERROR' }))
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'partial', counts: { created: 2, deleted: 0, failed: 2 } })
    expect(await ledger(w.targetId)).toEqual(['A', 'B', 'C', 'D'])
    const retry = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(retry).toMatchObject({ status: 'succeeded', counts: { deleted: 2 } })
    expect(await ledger(w.targetId)).toEqual(['C', 'D'])
  })

  it('non-retryable failures mark the target needs_attention and set no retry; a later success clears it', async () => {
    for (const code of ['PROVIDER_AUTH', 'PROVIDER_VALIDATION', 'TARGET_NOT_FOUND'] as const) {
      const e = createTestEnv()
      env = e
      provider = installFakeProvider()
      const w = await setupSyncWorld(env)
      provider.script.push(() => ({ ok: false, code }))
      const run = await runSync(env, w.targetId, { trigger: 'manual' })
      expect(run).toMatchObject({ status: 'failed', errorCode: code, nextRetryAt: null })
      expect((await target(w)).status).toBe('needs_attention')
      const again = await runSync(env, w.targetId, { trigger: 'manual' })
      expect(again.status).toBe('succeeded')
      expect((await target(w)).status).toBe('active')
    }
  })

  it('listNames failures map to the provider code without writing', async () => {
    const w = await setupSyncWorld(env)
    provider.listError = 'PROVIDER_AUTH'
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_AUTH' })
    expect(provider.pushCalls).toHaveLength(0)
  })

  it('a throwing provider becomes PROVIDER_ERROR and its message is never stored', async () => {
    const w = await setupSyncWorld(env)
    provider.script.push(() => { throw new Error(`boom ${CANARY}`) })
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' })
    const dump = JSON.stringify(await runRow(run.id))
    expect(dump).not.toContain(CANARY)
    expect(logged.join('\n')).not.toContain(CANARY)
  })
})

describe('retry helper', () => {
  it('backs off exponentially with jitter, caps, and stops at 5 attempts', () => {
    const lo = () => 0
    const hi = () => 1
    expect(computeRetryDelayMs(1, lo)).toBe(15_000)
    expect(computeRetryDelayMs(1, hi)).toBe(30_000)
    expect(computeRetryDelayMs(2, hi)).toBe(60_000)
    expect(computeRetryDelayMs(3, hi)).toBe(120_000)
    expect(computeRetryDelayMs(20, hi)).toBe(15 * 60_000)
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(computeNextRetryAt('TIMEOUT', 1, now, hi)).toBe('2026-01-01T00:00:30.000Z')
    expect(computeNextRetryAt('PROVIDER_ERROR', MAX_SYNC_ATTEMPTS - 1, now, hi)).not.toBeNull()
    expect(computeNextRetryAt('PROVIDER_ERROR', MAX_SYNC_ATTEMPTS, now, hi)).toBeNull()
    for (const code of ['PROVIDER_AUTH', 'PROVIDER_VALIDATION', 'TARGET_NOT_FOUND', 'COMPUTED_ERROR', 'CREDENTIAL_UNAVAILABLE'] as const) {
      expect(computeNextRetryAt(code, 1, now, hi)).toBeNull()
    }
    expect(computeNextRetryAt(null, 1, now, hi)).toBeNull()
  })

  it('jitter stays within [50%, 100%] of the exponential delay with real randomness', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelayMs(3)
      expect(d).toBeGreaterThanOrEqual(60_000)
      expect(d).toBeLessThanOrEqual(120_000)
    }
  })

  it('the engine sets next_retry_at for a retryable failure and stops after the last attempt', async () => {
    const w = await setupSyncWorld(env)
    provider.script.push(() => ({ ok: false, code: 'TIMEOUT' }), () => ({ ok: false, code: 'TIMEOUT' }))
    const early = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 4 })
    expect(early.nextRetryAt).not.toBeNull()
    expect((await runRow(early.id))!['next_retry_at']).toBe(early.nextRetryAt)
    const last = await runSync(env, w.targetId, { trigger: 'schedule', attempt: MAX_SYNC_ATTEMPTS })
    expect(last).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT', nextRetryAt: null })
  })
})

describe('delete toggle', () => {
  it('is OFF by default: names removed from the environment stay on the target', async () => {
    const w = await setupSyncWorld(env, { secrets: { KEEP: '1', GONE: '2' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'GONE'").run()
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.counts.deleted).toBe(0)
    expect(provider.remote.has('GONE')).toBe(true)
    expect(await ledger(w.targetId)).toEqual(['GONE', 'KEEP'])
  })

  it('when ON deletes only ledger names; names HushVault never created are never touched', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { KEEP: '1', GONE: '2' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    provider.remote.set('FOREIGN', 'not-ours')
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'GONE'").run()
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.delete).toEqual(['GONE'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'succeeded', counts: { deleted: 1 } })
    expect([...provider.remote.keys()].sort()).toEqual(['FOREIGN', 'KEEP'])
    expect(await ledger(w.targetId)).toEqual(['KEEP'])
  })

  it('when ON, a ledger name already gone from the target is forgotten without a provider call', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { KEEP: '1', GONE: '2' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'GONE'").run()
    provider.remote.delete('GONE')
    provider.pushCalls.length = 0
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(provider.pushCalls).toHaveLength(0)
    expect(await ledger(w.targetId)).toEqual(['KEEP'])
  })

  it('a conflict name is never deleted even with the toggle on', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { MINE: '1', THEIRS: '2' } })
    provider.remote.set('THEIRS', 'foreign')
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'THEIRS'").run()
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(provider.remote.get('THEIRS')).toBe('foreign')
  })
})

describe('fail closed on resolution errors', () => {
  it('a computed-secret error fails the run with COMPUTED_ERROR and makes zero provider calls', async () => {
    const w = await setupSyncWorld(env, { secrets: { GOOD: 'g' } })
    await seedComputed(env, w.projectId, w.envId, 'BROKEN', '${DOES_NOT_EXIST}')
    const run = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'COMPUTED_ERROR', nextRetryAt: null })
    expect(provider.listCalls).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)
    expect(provider.credentialsSeen).toEqual([])
    expect(await ledger(w.targetId)).toEqual([])
  })

  it('pushes computed secrets evaluated', async () => {
    const w = await setupSyncWorld(env, { secrets: { HOST: 'db.local' } })
    await seedComputed(env, w.projectId, w.envId, 'URL', 'postgres://${HOST}/app')
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(provider.remote.get('URL')).toBe('postgres://db.local/app')
  })
})

describe('credentials', () => {
  it('a missing or undecryptable credential fails with CREDENTIAL_UNAVAILABLE and no provider call', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare('UPDATE integration_connections SET encrypted_credential = ? WHERE id = ?').bind('garbage', w.connectionId).run()
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL_UNAVAILABLE', nextRetryAt: null })
    expect(provider.listCalls).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)
  })

  it('the credential reaches the provider but is never stored or logged', async () => {
    const w = await setupSyncWorld(env)
    const run = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    expect(provider.credentialsSeen.every((c) => c === CREDENTIAL)).toBe(true)
    expect(run.status).toBe('succeeded')
    expect(await everythingStored()).not.toContain(CREDENTIAL)
    expect(logged.join('\n')).not.toContain(CREDENTIAL)
  })
})

async function everythingStored(): Promise<string> {
  const tables = ['sync_items', 'sync_runs', 'sync_targets', 'audit_log']
  const out: unknown[] = []
  for (const t of tables) out.push((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)
  return JSON.stringify(out)
}

describe('no plaintext leaks', () => {
  it('a canary value appears in no sync table, audit row, plan, run DTO or log', async () => {
    const w = await setupSyncWorld(env, { secrets: { SECRET_ONE: CANARY, SECRET_TWO: `${CANARY}-2` } })
    const preview = await previewSync(env, w.orgId, w.targetId, { actorId: w.userId })
    const run = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    // Force a failure path too (value present in ops while the provider fails).
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'SECRET_TWO'").run()
    await seedSecret(env, w.projectId, w.envId, 'SECRET_TWO', `${CANARY}-3`)
    provider.script.push(() => { throw new Error(`provider echoed ${CANARY}`) })
    const failed = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    expect(failed.status).toBe('failed')

    expect(run.status).toBe('succeeded')
    expect(provider.remote.get('SECRET_ONE')).toBe(CANARY) // it did reach the target
    const haystack = JSON.stringify({ preview, run, failed }) + (await everythingStored()) + logged.join('\n')
    expect(haystack).not.toContain(CANARY)
    expect(haystack).not.toContain(CANARY.slice(0, 20) + '')
  })

  it('writes sync.run.* audit rows with the run id only, actorType user for manual and system for automatic', async () => {
    const w = await setupSyncWorld(env)
    const manual = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    const auto = await runSync(env, w.targetId, { trigger: 'schedule' })
    const rows = (await env.DB.prepare('SELECT action, actor_id, actor_type, resource_type, resource_id FROM audit_log WHERE org_id = ? ORDER BY timestamp, rowid').bind(w.orgId).all<Record<string, string | null>>()).results
    const byRun = (id: string) => rows.filter((r) => r['resource_id'] === id).map((r) => `${r['action']}:${r['actor_type']}`)
    expect(byRun(manual.id)).toEqual(['sync.run.started:user', 'sync.run.succeeded:user'])
    expect(byRun(auto.id)).toEqual(['sync.run.started:system', 'sync.run.succeeded:system'])
    expect(rows.filter((r) => r['action'] === 'secret.read_bulk').map((r) => [r['actor_type'], r['actor_id']])).toEqual([['user', w.userId], ['system', null]])
    expect(rows.find((r) => r['action'] === 'sync.run.started')!['resource_type']).toBe('sync_run')
    expect(await auditActions(env, w.orgId)).toContain('secret.read_bulk')
  })

  it('writes sync.run.failed on failure', async () => {
    const w = await setupSyncWorld(env)
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_AUTH' }))
    const run = await runSync(env, w.targetId, { trigger: 'change' })
    expect(await auditActions(env, w.orgId, run.id)).toEqual(['sync.run.started', 'sync.run.failed'])
  })

  it('fails closed when the bulk-read audit cannot be written (no read without a record)', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare('DROP TABLE audit_log').run()
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).toBe('failed')
    expect(provider.pushCalls).toHaveLength(0)
  })
})

describe('fingerprints', () => {
  it('is a keyed HMAC, not a plain hash, and changes with JWT_SECRET and the target salt', async () => {
    const w = await setupSyncWorld(env, { secrets: { TOKEN: 'abc' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    const row = await env.DB.prepare('SELECT fingerprint FROM sync_items WHERE target_id = ?').bind(w.targetId).first<{ fingerprint: string }>()
    const fp = row!.fingerprint
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    for (const plain of ['abc', 'TOKEN\u0000abc', 'TOKENabc']) {
      expect(fp).not.toBe(createHash('sha256').update(plain).digest('hex'))
    }
    const t = await target(w)
    expect(await computeFingerprint(env, t.fingerprintSalt, 'TOKEN', 'abc')).toBe(fp)
    expect(await computeFingerprint(env, `${t.fingerprintSalt}x`, 'TOKEN', 'abc')).not.toBe(fp)
    expect(await computeFingerprint(env, t.fingerprintSalt, 'TOKEN', 'abd')).not.toBe(fp)
    expect(await computeFingerprint(env, t.fingerprintSalt, 'TOKEN2', 'abc')).not.toBe(fp)

    // Rotating JWT_SECRET only causes an extra re-push, never a wrong skip.
    env.JWT_SECRET = 'a-completely-different-jwt-secret-for-rotation-0000'
    expect(await computeFingerprint(env, t.fingerprintSalt, 'TOKEN', 'abc')).not.toBe(fp)
    provider.pushCalls.length = 0
    const rerun = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(rerun).toMatchObject({ status: 'succeeded', counts: { updated: 1 } })
    expect(provider.pushCalls.flat().map((o) => o.name)).toEqual(['TOKEN'])
  })

  it('unchanged values are skipped on the next run', async () => {
    const w = await setupSyncWorld(env)
    await runSync(env, w.targetId, { trigger: 'manual' })
    provider.pushCalls.length = 0
    const again = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(again.counts).toMatchObject({ created: 0, updated: 0, skipped: 2 })
    expect(provider.pushCalls).toHaveLength(0)
  })
})

describe('single flight', () => {
  it('two concurrent runs: one pushes, the other returns the existing run', async () => {
    const w = await setupSyncWorld(env)
    let release!: () => void
    provider.gate = new Promise<void>((resolve) => { release = resolve })
    const a = runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    const b = runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId })
    // The loser resolves while the winner is still gated.
    const second = await Promise.race([b, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000))])
    expect(second).not.toBe('timeout')
    if (second === 'timeout') return
    expect(second.status).toBe('running')
    release()
    const first = await a
    expect(first.id).toBe(second.id)
    expect(first.status).toBe('succeeded')
    expect(provider.pushCalls).toHaveLength(1)
    const runs = await env.DB.prepare('SELECT id FROM sync_runs WHERE target_id = ?').bind(w.targetId).all()
    expect(runs.results).toHaveLength(1)
  })

  it('a finished run does not block the next one', async () => {
    const w = await setupSyncWorld(env)
    const one = await runSync(env, w.targetId, { trigger: 'manual' })
    const two = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(two.id).not.toBe(one.id)
  })

  it('a crashed run with an expired lease is closed and a new run proceeds; a live lease blocks', async () => {
    const w = await setupSyncWorld(env)
    const t0 = new Date('2026-03-01T00:00:00.000Z')
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES ('isr_stale', ?, 'manual', 'running', 1, ?, ?)")
      .bind(w.targetId, t0.toISOString(), new Date(t0.getTime() + SYNC_LEASE_MS).toISOString()).run()
    const blocked = await runSync(env, w.targetId, { trigger: 'manual', now: new Date(t0.getTime() + 1000) })
    expect(blocked.id).toBe('isr_stale')
    expect(provider.pushCalls).toHaveLength(0)
    const later = await runSync(env, w.targetId, { trigger: 'manual', now: new Date(t0.getTime() + SYNC_LEASE_MS + 1000) })
    expect(later.status).toBe('succeeded')
    expect(await runRow('isr_stale')).toMatchObject({ status: 'failed', error_code: 'TIMEOUT' })
  })
})

describe('organisation isolation', () => {
  it('runSync refuses a target outside the given organisation', async () => {
    const a = await setupSyncWorld(env)
    const b = await seedUser(env, { role: 'admin' })
    await expect(runSync(env, a.targetId, { trigger: 'manual', orgId: b.orgId })).rejects.toBeInstanceOf(SyncEngineError)
    await expect(previewSync(env, b.orgId, a.targetId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(provider.pushCalls).toHaveLength(0)
  })

  it('a target pointing at another organisation\'s environment fails closed and pushes nothing', async () => {
    const a = await setupSyncWorld(env, { secrets: { A_SECRET: CANARY } })
    const b = await seedUser(env, { role: 'admin' })
    const bProject = await seedProject(env, b.orgId)
    const bConn = await seedConnection(env, b.orgId, b.userId)
    const evil = await seedTarget(env, { orgId: b.orgId, projectId: a.projectId, envId: a.envId, connectionId: bConn })
    const run = await runSync(env, evil, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'COMPUTED_ERROR' })
    expect(provider.listCalls).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)
    void bProject
  })

  it('a target using another organisation\'s connection cannot read its credential', async () => {
    const a = await setupSyncWorld(env)
    const b = await seedUser(env, { role: 'admin' })
    const bConn = await seedConnection(env, b.orgId, b.userId, 'org-b-credential')
    const evil = await seedTarget(env, { orgId: a.orgId, projectId: a.projectId, envId: a.envId, connectionId: bConn })
    const run = await runSync(env, evil, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL_UNAVAILABLE' })
    expect(provider.credentialsSeen).toEqual([])
  })

  it('runs are only readable through their own organisation', async () => {
    const { loadSyncRun } = await import('../src/integrations/sync-engine')
    const a = await setupSyncWorld(env)
    const b = await seedUser(env, { role: 'admin' })
    const run = await runSync(env, a.targetId, { trigger: 'manual' })
    expect(await loadSyncRun(env, a.orgId, run.id)).toMatchObject({ id: run.id })
    expect(await loadSyncRun(env, b.orgId, run.id)).toBeNull()
  })
})

describe('target lifecycle', () => {
  it('a soft-deleted target cannot run', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare('UPDATE sync_targets SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), w.targetId).run()
    await expect(runSync(env, w.targetId, { trigger: 'manual' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deleting the connection removes the target, its ledger and runs (it can never run without a credential)', async () => {
    const w = await setupSyncWorld(env)
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare('DELETE FROM integration_connections WHERE id = ?').bind(w.connectionId).run()
    expect(await env.DB.prepare('SELECT id FROM sync_targets').first()).toBeNull()
    expect(await env.DB.prepare('SELECT name FROM sync_items').first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM sync_runs').first()).toBeNull()
  })

  it('an unregistered provider module is refused before any run row exists', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare("UPDATE sync_targets SET provider = 'nope' WHERE id = ?").bind(w.targetId).run()
    await expect(runSync(env, w.targetId, { trigger: 'manual' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(await env.DB.prepare('SELECT id FROM sync_runs').first()).toBeNull()
  })

  it('stores counts and timestamps on the run row', async () => {
    const w = await setupSyncWorld(env)
    const run = await runSync(env, w.targetId, { trigger: 'manual', now: new Date('2026-02-02T02:02:02.000Z') })
    expect(run.startedAt).toBe('2026-02-02T02:02:02.000Z')
    const row = await runRow(run.id)
    expect(JSON.parse(String(row!['counts_json']))).toEqual({ created: 2, updated: 0, deleted: 0, skipped: 0, failed: 0 })
    expect(row!['lease_until']).toBeNull()
    expect(row!['finished_at']).not.toBeNull()
    const t = await target(w)
    expect(t.lastRunAt).not.toBeNull()
  })
})
