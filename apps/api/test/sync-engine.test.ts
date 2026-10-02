import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeFingerprint,
  computeNextRetryAt,
  computeRetryDelayMs,
  isReservedSyncName,
  loadSyncTarget,
  MAX_SYNC_ATTEMPTS,
  RATE_LIMIT_MIN_WAIT_MS,
  planSync,
  previewSync,
  runSync,
  SyncEngineError,
  SYNC_LEASE_MS,
} from '../src/integrations/sync-engine'
import { auditActions } from './helpers/projects-seed'
import { createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import type { PushInput, PushResult } from '../src/integrations/sync-types'
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
    // Every secret-typed Env key: ENCRYPTION_*, JWT_SECRET, OAuth client secrets, Stripe keys.
    for (const n of [
      'ENCRYPTION_MASTER_KEY', 'ENCRYPTION_KEY_V2', 'ENCRYPTION_KEY_V10', 'ENCRYPTION_KEY', 'ENCRYPTION_ACTIVE_KEY_VERSION', 'JWT_SECRET', 'jwt_secret',
      'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'stripe_webhook_secret',
    ]) expect(isReservedSyncName(n), n).toBe(true)
    for (const n of ['MY_JWT_SECRET', 'GITHUB_CLIENT_ID', 'STRIPE_PUBLISHABLE_KEY', 'MY_ENCRYPTION_KEY', 'API_KEY']) expect(isReservedSyncName(n), n).toBe(false)
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

  it('a failed audit write never fails the plan or the run; it is logged by event name only', async () => {
    const w = await setupSyncWorld(env, { secrets: { SECRET_ONE: CANARY } })
    await env.DB.prepare('DROP TABLE audit_log').run()
    const planned = await planSync(env, await target(w), provider)
    expect(planned.ok).toBe(true)
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).toBe('succeeded')
    expect(provider.remote.get('SECRET_ONE')).toBe(CANARY)
    expect(logged.some((l) => l.includes('sync.audit_failed'))).toBe(true)
    expect(logged.join('\n')).not.toContain(CANARY)
  })

  it('threads ip and user agent into the sync.run.* and secret.read_bulk audit rows', async () => {
    const w = await setupSyncWorld(env)
    await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId, ip: '203.0.113.9', userAgent: 'hushvault-test/1' })
    const rows = (await env.DB.prepare("SELECT action, ip, user_agent FROM audit_log WHERE action LIKE 'sync.run.%' OR action = 'secret.read_bulk'").all<Record<string, string | null>>()).results
    expect(rows.map((r) => r['action']).sort()).toEqual(['secret.read_bulk', 'sync.run.started', 'sync.run.succeeded'])
    for (const r of rows) expect([r['ip'], r['user_agent']]).toEqual(['203.0.113.9', 'hushvault-test/1'])
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

// ---------------------------------------------------------------------------------------------
// Review fixes (issue #41 follow-ups)
// ---------------------------------------------------------------------------------------------

const ledgerRows = async (targetId: string) =>
  Object.fromEntries((await env.DB.prepare('SELECT name, fingerprint FROM sync_items WHERE target_id = ?').bind(targetId).all<{ name: string; fingerprint: string }>()).results.map((r) => [r.name, r.fingerprint]))

/** maxItems 2 with A,B ledgered and the environment swapped to C,D: chunk 1 = the sets, chunk 2 = the deletes. */
async function swapEnvWorld() {
  provider = installFakeProvider({ maxItems: 2 })
  const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { A: '1', B: '2' } })
  await runSync(env, w.targetId, { trigger: 'manual' })
  await env.DB.prepare("DELETE FROM secrets WHERE name IN ('A', 'B')").run()
  await seedSecret(env, w.projectId, w.envId, 'C', '3')
  await seedSecret(env, w.projectId, w.envId, 'D', '4')
  provider.pushCalls.length = 0
  return w
}


describe('unsafe names', () => {
  it('__proto__, constructor and prototype are NAME_INVALID blockers: never planned, never sent, never ledgered', async () => {
    const w = await setupSyncWorld(env, { secrets: { __proto__: 'p', constructor: 'c', prototype: 'q', Prototype: 'r', GOOD: 'g' } })
    // Object.entries(...) above skips nothing: __proto__ in a literal sets the prototype, so seed it explicitly.
    await seedSecret(env, w.projectId, w.envId, '__proto__', 'p')
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    const invalid = planned.plan.blockers.find((b) => b.code === 'NAME_INVALID')
    expect(invalid?.names).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'prototype', 'Prototype']))
    expect(planned.plan.create).toEqual(['GOOD'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_VALIDATION' })
    expect(provider.pushCalls).toHaveLength(0)
    expect(await ledger(w.targetId)).toEqual([])
  })
})

describe('empty values', () => {
  it('an empty value is an EMPTY_VALUE blocker (provider behaviour is unverified), listed by name only', async () => {
    const w = await setupSyncWorld(env, { secrets: { FULL: 'x', BLANK: '' } })
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.blockers).toEqual([{ code: 'EMPTY_VALUE', names: ['BLANK'] }])
    expect(planned.plan.create).toEqual(['FULL'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_VALIDATION' })
    expect(provider.pushCalls).toHaveLength(0)
  })
})

describe('intent-first ledger (lost responses)', () => {
  /** Apply the ops on the fake target, then lose the response like a dropped connection. */
  const applyThenLose = (fail: (input: PushInput) => PushResult | never) => (input: PushInput): PushResult => {
    for (const op of input.ops) {
      if (op.type === 'set') provider.remote.set(op.name, op.value)
      else provider.remote.delete(op.name)
    }
    return fail(input)
  }

  it('writes a pending ledger row for every set BEFORE the provider is called', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: '1', B: '2' } })
    let seen: Record<string, string> = {}
    const original = provider.push
    provider.push = async (input) => {
      seen = await ledgerRows(w.targetId)
      return original(input)
    }
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(seen).toEqual({ A: 'pending', B: 'pending' })
    expect(Object.values(await ledgerRows(w.targetId)).every((fp) => /^[0-9a-f]{64}$/.test(fp))).toBe(true)
  })

  for (const [label, lose] of [
    ['a TIMEOUT result', (): PushResult => ({ ok: false, code: 'TIMEOUT' })],
    ['a thrown network error', (): PushResult => { throw new Error('socket hang up') }],
    ['an item result flagged maybeApplied', (): PushResult => ({ ok: true, results: [{ name: 'A', ok: false, code: 'PROVIDER_ERROR', maybeApplied: true }, { name: 'B', ok: false, code: 'PROVIDER_ERROR', maybeApplied: true }] })],
  ] as const) {
    it(`end to end: bulk applied but the response was lost (${label}); the next run updates the names instead of calling them conflicts forever`, async () => {
      const w = await setupSyncWorld(env, { secrets: { A: '1', B: '2' } })
      provider.script.push(applyThenLose(lose))
      const first = await runSync(env, w.targetId, { trigger: 'manual' })
      expect(first.status).toBe('failed')
      expect(first.nextRetryAt).not.toBeNull()
      // The names exist on the Worker, and the ledger knows they are ours (pending), not missing.
      expect([...provider.remote.keys()].sort()).toEqual(['A', 'B'])
      expect(await ledgerRows(w.targetId)).toEqual({ A: 'pending', B: 'pending' })

      const planned = await planSync(env, await target(w), provider)
      if (!planned.ok) throw new Error('plan failed')
      expect(planned.plan).toMatchObject({ create: [], update: ['A', 'B'], conflict: [] })

      const second = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
      expect(second).toMatchObject({ status: 'succeeded', counts: { updated: 2, created: 0, skipped: 0 } })
      expect(Object.values(await ledgerRows(w.targetId)).every((fp) => /^[0-9a-f]{64}$/.test(fp))).toBe(true)
      const third = await runSync(env, w.targetId, { trigger: 'manual' })
      expect(third.counts).toMatchObject({ skipped: 2, created: 0, updated: 0 })
    })
  }

  it('a pending name that is gone from the target is created again (not stuck)', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: '1' } })
    provider.script.push(() => ({ ok: false, code: 'TIMEOUT' }))
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(await ledgerRows(w.targetId)).toEqual({ A: 'pending' })
    const run = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(run).toMatchObject({ status: 'succeeded', counts: { created: 1 } })
  })

  it('a definite failure removes the pending row of a name that was never ledgered, and keeps the old fingerprint of one that was', async () => {
    const w = await setupSyncWorld(env, { secrets: { OLD: 'v1' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    const before = (await ledgerRows(w.targetId))['OLD']
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'OLD'").run()
    await seedSecret(env, w.projectId, w.envId, 'OLD', 'v2')
    await seedSecret(env, w.projectId, w.envId, 'NEW', 'n')
    provider.script.push(() => ({ ok: true, results: [{ name: 'NEW', ok: false, code: 'PROVIDER_VALIDATION' }, { name: 'OLD', ok: false, code: 'PROVIDER_VALIDATION' }] }))
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).toBe('failed')
    expect(await ledgerRows(w.targetId)).toEqual({ OLD: before })
    // and a chunk-level definite failure (auth) leaves no pending rows either
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_AUTH' }))
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(await ledgerRows(w.targetId)).toEqual({ OLD: before })
  })

  it('an unknown outcome on an already ledgered name keeps its row and the next run rewrites it', async () => {
    const w = await setupSyncWorld(env, { secrets: { OLD: 'v1' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'OLD'").run()
    await seedSecret(env, w.projectId, w.envId, 'OLD', 'v2')
    provider.script.push(applyThenLose(() => ({ ok: false, code: 'TIMEOUT' })))
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(provider.remote.get('OLD')).toBe('v2')
    const again = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(again).toMatchObject({ status: 'succeeded', counts: { updated: 1 } })
  })

  it('pending names are still ledger names: removed from the environment they are deleted (toggle on)', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { A: '1' } })
    provider.script.push(applyThenLose(() => ({ ok: false, code: 'TIMEOUT' })))
    await runSync(env, w.targetId, { trigger: 'manual' })
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'A'").run()
    const run = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(run.counts.deleted).toBe(1)
    expect(provider.remote.has('A')).toBe(false)
    expect(await ledger(w.targetId)).toEqual([])
  })

  it('a ledger write failure after a successful push leaves the pending rows (nothing orphaned)', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: '1' } })
    const realBatch = env.DB.batch.bind(env.DB)
    let calls = 0
    env.DB.batch = (async (statements: unknown[]) => {
      calls += 1
      // 1st batch = intent rows, 2nd = the confirmation after the push: fail it.
      if (calls === 2) throw new Error('D1 down')
      return realBatch(statements as never)
    }) as typeof env.DB.batch
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    env.DB.batch = realBatch
    expect(run.status).not.toBe('succeeded')
    expect(provider.remote.get('A')).toBe('1')
    expect(await ledgerRows(w.targetId)).toEqual({ A: 'pending' })
  })
})

describe('provider capacity', () => {
  it('counts names already on the target, not only wanted: foreign secrets plus new names over the cap block the run', async () => {
    provider = installFakeProvider({ maxItems: 4 })
    const w = await setupSyncWorld(env, { secrets: { A_NEW: '1', B_NEW: '2' } })
    provider.remote.set('FOREIGN_1', 'x')
    provider.remote.set('FOREIGN_2', 'y')
    provider.remote.set('FOREIGN_3', 'z')
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    // 3 foreign + 2 wanted = 5 > 4: exactly one name over, the last in sort order.
    expect(planned.plan.blockers).toEqual([{ code: 'TOO_MANY_ITEMS', names: ['B_NEW'] }])
    expect(planned.plan.create).toEqual(['A_NEW'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_VALIDATION' })
    expect(provider.pushCalls).toHaveLength(0)
  })

  it('names we update (already there) cost nothing, deletes free capacity, and a full target with no creates is fine', async () => {
    provider = installFakeProvider({ maxItems: 3 })
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { A: '1', B: '2', C: '3' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    // at the cap with only updates: fine
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'A'").run()
    await seedSecret(env, w.projectId, w.envId, 'A', '1-new')
    let planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.blockers).toEqual([])
    expect(planned.plan.update).toEqual(['A'])
    // swap C for D: the delete frees the slot the create needs
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'C'").run()
    await seedSecret(env, w.projectId, w.envId, 'D', '4')
    planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.blockers).toEqual([])
    expect(planned.plan).toMatchObject({ create: ['D'], delete: ['C'] })
    // ...but without the toggle nothing is freed
    await env.DB.prepare('UPDATE sync_targets SET delete_removed = 0 WHERE id = ?').bind(w.targetId).run()
    planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.blockers).toEqual([{ code: 'TOO_MANY_ITEMS', names: ['D'] }])
  })

  it('a target already over the cap because of foreign secrets still allows updates', async () => {
    provider = installFakeProvider({ maxItems: 2 })
    const w = await setupSyncWorld(env, { secrets: { A: '1' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    for (const n of ['F1', 'F2', 'F3']) provider.remote.set(n, 'x')
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'A'").run()
    await seedSecret(env, w.projectId, w.envId, 'A', 'changed')
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'succeeded', counts: { updated: 1 } })
  })
})

describe('denylist inside the engine', () => {
  it('planSync refuses a denied script and a denied account, before decrypting or calling the provider', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare('UPDATE sync_targets SET resource_json = ? WHERE id = ?').bind(JSON.stringify({ scriptName: 'HushVault-Web-Local' }), w.targetId).run()
    expect(await planSync(env, await target(w), provider)).toEqual({ ok: false, code: 'TARGET_NOT_ALLOWED' })
    await env.DB.prepare('UPDATE sync_targets SET resource_json = ? WHERE id = ?').bind(JSON.stringify({ scriptName: 'customer-app', accountId: 'ABCDEF0123456789abcdef0123456789' }), w.targetId).run()
    env.HUSHVAULT_SYNC_DENY_ACCOUNT_IDS = 'x, abcdef0123456789ABCDEF0123456789'
    expect(await planSync(env, await target(w), provider)).toEqual({ ok: false, code: 'TARGET_NOT_ALLOWED' })
    expect(provider.listCalls).toBe(0)
    expect(provider.credentialsSeen).toEqual([])
  })

  it('runSync records a failed TARGET_NOT_ALLOWED run, flags the target, and sends nothing (also for the connection account)', async () => {
    const w = await setupSyncWorld(env)
    env.HUSHVAULT_SYNC_DENY_SCRIPTS = 'worker-a'
    const run = await runSync(env, w.targetId, { trigger: 'schedule' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'TARGET_NOT_ALLOWED', nextRetryAt: null })
    expect((await target(w)).status).toBe('needs_attention')
    expect(provider.listCalls).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)

    env.HUSHVAULT_SYNC_DENY_SCRIPTS = ''
    // the fixture connection's config is { accountId: 'acc1' }
    env.HUSHVAULT_SYNC_DENY_ACCOUNT_IDS = 'ACC1'
    const viaConnection = await runSync(env, w.targetId, { trigger: 'schedule' })
    expect(viaConnection).toMatchObject({ status: 'failed', errorCode: 'TARGET_NOT_ALLOWED' })
    expect(provider.listCalls).toBe(0)
    expect(provider.credentialsSeen).toEqual([])

    env.HUSHVAULT_SYNC_DENY_ACCOUNT_IDS = ''
    expect((await runSync(env, w.targetId, { trigger: 'manual' })).status).toBe('succeeded')
    expect((await target(w)).status).toBe('active')
  })
})

describe('needs_attention and distinct resolution codes', () => {
  it('COMPUTED_ERROR and CREDENTIAL_UNAVAILABLE flag the target and do not retry', async () => {
    const w = await setupSyncWorld(env, { secrets: { GOOD: 'g' } })
    await seedComputed(env, w.projectId, w.envId, 'BROKEN', '${DOES_NOT_EXIST}')
    const computed = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(computed).toMatchObject({ status: 'failed', errorCode: 'COMPUTED_ERROR', nextRetryAt: null })
    expect((await target(w)).status).toBe('needs_attention')

    const v = await setupSyncWorld(env)
    await env.DB.prepare('UPDATE integration_connections SET encrypted_credential = ? WHERE id = ?').bind('garbage', v.connectionId).run()
    const cred = await runSync(env, v.targetId, { trigger: 'manual' })
    expect(cred).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL_UNAVAILABLE', nextRetryAt: null })
    expect((await target(v)).status).toBe('needs_attention')
  })

  it('a secret that cannot be decrypted is DECRYPTION_FAILED, not COMPUTED_ERROR', async () => {
    const w = await setupSyncWorld(env, { secrets: { GOOD: 'g' } })
    const row = await env.DB.prepare("SELECT id FROM secrets WHERE name = 'GOOD'").first<{ id: string }>()
    await env.SECRETS_KV.delete(`secret:${row!.id}`)
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'DECRYPTION_FAILED', nextRetryAt: null })
    expect((await target(w)).status).toBe('needs_attention')
    expect(provider.listCalls).toBe(0)
  })
})

describe('retry scheduling', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z')
  const hi = () => 1
  const lo = () => 0

  it('a rate limit waits at least 5 minutes, or Retry-After when longer', () => {
    expect(RATE_LIMIT_MIN_WAIT_MS).toBe(5 * 60_000)
    expect(new Date(computeNextRetryAt('PROVIDER_RATE_LIMIT', 1, t0, lo)!).getTime() - t0.getTime()).toBe(300_000)
    expect(new Date(computeNextRetryAt('PROVIDER_RATE_LIMIT', 1, t0, lo, 1200)!).getTime() - t0.getTime()).toBe(1_200_000)
    expect(new Date(computeNextRetryAt('PROVIDER_RATE_LIMIT', 1, t0, hi, 10)!).getTime() - t0.getTime()).toBe(300_000)
    // other retryable codes keep the normal backoff, and Retry-After does not apply to them
    expect(computeNextRetryAt('PROVIDER_ERROR', 1, t0, hi, 1200)).toBe('2026-01-01T00:00:30.000Z')
    expect(computeNextRetryAt('PROVIDER_RATE_LIMIT', MAX_SYNC_ATTEMPTS, t0, lo)).toBeNull()
  })

  it('the engine applies the floor and carries the provider Retry-After through chunk and item results', async () => {
    const w = await setupSyncWorld(env)
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_RATE_LIMIT' }))
    const plain = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(new Date(plain.nextRetryAt!).getTime() - Date.now()).toBeGreaterThan(295_000)

    provider.script.push(() => ({ ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 1800 }))
    const chunkLevel = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(new Date(chunkLevel.nextRetryAt!).getTime() - Date.now()).toBeGreaterThan(1_795_000)

    provider.script.push(() => ({ ok: true, results: [{ name: 'DB_URL', ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 2400 }, { name: 'API_KEY', ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 600 }] }))
    const itemLevel = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(new Date(itemLevel.nextRetryAt!).getTime() - Date.now()).toBeGreaterThan(2_395_000)
  })

  it('a list-stage rate limit also waits (Retry-After carried from listNames)', async () => {
    const w = await setupSyncWorld(env)
    const original = provider.listNames
    provider.listNames = async () => ({ ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 900 })
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    provider.listNames = original
    expect(run.errorCode).toBe('PROVIDER_RATE_LIMIT')
    expect(new Date(run.nextRetryAt!).getTime() - Date.now()).toBeGreaterThan(895_000)
  })

  it('retryability looks at every error of the run, not only the most actionable one', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: '1', B: '2' } })
    provider.script.push(() => ({ ok: true, results: [{ name: 'A', ok: false, code: 'PROVIDER_VALIDATION' }, { name: 'B', ok: false, code: 'PROVIDER_ERROR' }] }))
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.errorCode).toBe('PROVIDER_VALIDATION') // most actionable...
    expect(run.nextRetryAt).not.toBeNull() // ...but B can be retried
    expect((await target(w)).status).toBe('needs_attention') // and A needs a person
  })

  it('starting a run clears next_retry_at on the target\'s other runs; so does a success; a failure keeps only its own', async () => {
    const w = await setupSyncWorld(env)
    const seedOld = async (id: string) => env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, finished_at, next_retry_at) VALUES (?, ?, 'schedule', 'failed', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z')").bind(id, w.targetId).run()
    const pending = async () => (await env.DB.prepare('SELECT id FROM sync_runs WHERE target_id = ? AND next_retry_at IS NOT NULL ORDER BY id').bind(w.targetId).all<{ id: string }>()).results.map((r) => r.id)
    await seedOld('isr_old1')
    await seedOld('isr_old2')
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_ERROR' }))
    const failed = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 2 })
    expect(await pending()).toEqual([failed.id]) // old ones cleared at start; only the new retry is scheduled
    const ok = await runSync(env, w.targetId, { trigger: 'schedule', attempt: 3 })
    expect(ok.status).toBe('succeeded')
    expect(await pending()).toEqual([])
  })

  it('a run that cannot start (single flight) clears nothing', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, finished_at, next_retry_at) VALUES ('isr_retry', ?, 'schedule', 'failed', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z')").bind(w.targetId).run()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES ('isr_live', ?, 'manual', 'running', 1, ?, '2999-01-01T00:00:00.000Z')").bind(w.targetId, new Date().toISOString()).run()
    const busy = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(busy.id).toBe('isr_live')
    expect((await runRow('isr_retry'))!['next_retry_at']).toBe('2099-01-01T00:00:00.000Z')
  })
})

describe('name filter changes forget instead of delete', () => {
  it('a name that fell out of the wanted set only because the filter changed is dropped from the ledger and never deleted on the target', async () => {
    const w = await setupSyncWorld(env, { deleteRemoved: true, secrets: { APP_ONE: '1', APP_TWO: '2', OTHER: '3', GONE: '4' } })
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(await ledger(w.targetId)).toEqual(['APP_ONE', 'APP_TWO', 'GONE', 'OTHER'])
    // GONE leaves the environment; OTHER and APP_TWO fall out of the filter.
    await env.DB.prepare("DELETE FROM secrets WHERE name = 'GONE'").run()
    await env.DB.prepare('UPDATE sync_targets SET name_filter_json = ? WHERE id = ?').bind(JSON.stringify({ prefix: 'APP_', deny: ['APP_TWO'] }), w.targetId).run()
    const planned = await planSync(env, await target(w), provider)
    if (!planned.ok) throw new Error('plan failed')
    expect(planned.plan.delete).toEqual(['GONE'])
    expect(planned.forget.sort()).toEqual(['APP_TWO', 'OTHER'])
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run).toMatchObject({ status: 'succeeded', counts: { deleted: 1 } })
    expect([...provider.remote.keys()].sort()).toEqual(['APP_ONE', 'APP_TWO', 'OTHER'])
    expect(await ledger(w.targetId)).toEqual(['APP_ONE'])
  })
})

describe('stale runs cannot write after the target changed', () => {
  it('a resource change during a chunk blocks the ledger writes and every later chunk', async () => {
    const w = await swapEnvWorld()
    provider.script.push(async () => {
      // What PATCH /targets/:id does when the resource changes: new resource, ledger reset.
      await env.DB.prepare('UPDATE sync_targets SET resource_json = ? WHERE id = ?').bind(JSON.stringify({ scriptName: 'worker-b' }), w.targetId).run()
      await env.DB.prepare('DELETE FROM sync_items WHERE target_id = ?').bind(w.targetId).run()
      return undefined
    })
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(run.status).not.toBe('succeeded')
    expect(provider.pushCalls).toHaveLength(1) // the delete chunk was never sent to the old Worker
    expect(await ledger(w.targetId)).toEqual([]) // nothing written against the new resource
  })

  it('a soft-deleted target gets no ledger rows from an in-flight run', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: '1' } })
    provider.script.push(async () => {
      await env.DB.prepare('UPDATE sync_targets SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), w.targetId).run()
      await env.DB.prepare('DELETE FROM sync_items WHERE target_id = ?').bind(w.targetId).run()
      return undefined
    })
    await runSync(env, w.targetId, { trigger: 'manual' })
    expect(await ledger(w.targetId)).toEqual([])
  })
})

describe('finishing a run', () => {
  const failBatchesContaining = (needle: string, times: number) => {
    const real = env.DB.batch.bind(env.DB)
    let left = times
    env.DB.batch = (async (statements: Array<{ sql: string }>) => {
      if (left > 0 && statements.some((s) => s.sql.includes(needle))) {
        left -= 1
        throw new Error('D1 unavailable')
      }
      return real(statements as never)
    }) as typeof env.DB.batch
    return () => { env.DB.batch = real }
  }

  it('retries the final run+target batch once', async () => {
    const w = await setupSyncWorld(env)
    const restore = failBatchesContaining('UPDATE sync_targets SET last_run_at', 1)
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    restore()
    expect(run.status).toBe('succeeded')
    expect(await runRow(run.id)).toMatchObject({ status: 'succeeded' })
    expect((await target(w)).lastRunAt).not.toBeNull()
  })

  it('if the batch fails twice the run is marked failed (never left running) with a retry', async () => {
    const w = await setupSyncWorld(env)
    const restore = failBatchesContaining('UPDATE sync_targets SET last_run_at', 2)
    const run = await runSync(env, w.targetId, { trigger: 'manual' })
    restore()
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' })
    expect(run.nextRetryAt).not.toBeNull()
    expect(await runRow(run.id)).toMatchObject({ status: 'failed', error_code: 'PROVIDER_ERROR', lease_until: null })
    // the single-flight slot is free again
    expect((await runSync(env, w.targetId, { trigger: 'manual' })).status).toBe('succeeded')
  })

  it('only closes a run that is still running: a run taken over by a newer one is not overwritten', async () => {
    const w = await setupSyncWorld(env)
    let runId = ''
    provider.script.push(async () => {
      const row = await env.DB.prepare("SELECT id FROM sync_runs WHERE status = 'running'").first<{ id: string }>()
      runId = row!.id
      // Another worker closed this run (expired lease) while it was still pushing.
      await env.DB.prepare("UPDATE sync_runs SET status = 'failed', error_code = 'TIMEOUT', finished_at = ?, lease_until = NULL WHERE id = ?").bind('2026-05-05T00:00:00.000Z', runId).run()
      return undefined
    })
    const before = await target(w)
    const result = await runSync(env, w.targetId, { trigger: 'manual' })
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error_code: 'TIMEOUT', finished_at: '2026-05-05T00:00:00.000Z' })
    expect(result).toMatchObject({ id: runId, status: 'failed', errorCode: 'TIMEOUT' })
    expect((await target(w)).lastRunAt).toBe(before.lastRunAt) // the stale run did not touch the target either
  })
})

describe('lease extension', () => {
  it('uses real elapsed time (Date.now), not the injected start time', async () => {
    const w = await swapEnvWorld()
    const real = Date.now.bind(Date)
    let skew = 0
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew)
    const start = new Date('2026-04-01T00:00:00.000Z')
    let leaseSeenByChunk2 = ''
    provider.script.push(
      () => { skew = 4 * 60_000; return undefined }, // chunk 1 "takes" 4 minutes
      async () => {
        const row = await env.DB.prepare("SELECT lease_until FROM sync_runs WHERE status = 'running'").first<{ lease_until: string }>()
        leaseSeenByChunk2 = row!.lease_until
        return undefined
      },
    )
    const run = await runSync(env, w.targetId, { trigger: 'manual', now: start })
    expect(run).toMatchObject({ status: 'succeeded' })
    // start + 4 min elapsed + the 5 min lease; a start-time based lease would still read start + 5 min.
    expect(new Date(leaseSeenByChunk2).getTime()).toBeGreaterThanOrEqual(start.getTime() + 9 * 60_000)
    expect(new Date(leaseSeenByChunk2).getTime()).toBeLessThan(start.getTime() + 9 * 60_000 + 30_000)
  })
})

describe('single plan for the run endpoint', () => {
  it('returnBlocked hands back the plan from the one plan the run made, keeps no run row, and reads the environment once', async () => {
    const w = await setupSyncWorld(env, { secrets: { OK: 'a', BLANK: '' } })
    const result = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId, returnBlocked: true })
    expect(result).toMatchObject({ blocked: { blockers: [{ code: 'EMPTY_VALUE', names: ['BLANK'] }], create: ['OK'] } })
    expect(provider.listCalls).toBe(1)
    expect(provider.pushCalls).toHaveLength(0)
    expect(await env.DB.prepare('SELECT id FROM sync_runs').first()).toBeNull()
    expect(await auditActions(env, w.orgId)).toEqual(['secret.read_bulk'])
  })

  it('an active run is returned before anything is planned (no decryption, no provider call, no audit)', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES ('isr_live', ?, 'manual', 'running', 1, ?, '2999-01-01T00:00:00.000Z')").bind(w.targetId, new Date().toISOString()).run()
    const result = await runSync(env, w.targetId, { trigger: 'manual', actorId: w.userId, returnBlocked: true })
    expect(result).toMatchObject({ id: 'isr_live', status: 'running' })
    expect(provider.listCalls).toBe(0)
    expect(await auditActions(env, w.orgId)).toEqual([])
  })

  it('without returnBlocked a blocked plan is still a recorded failed run (scheduler behaviour)', async () => {
    const w = await setupSyncWorld(env, { secrets: { BLANK: '' } })
    const run = await runSync(env, w.targetId, { trigger: 'schedule' })
    expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_VALIDATION' })
    expect(await runRow(run.id)).not.toBeNull()
  })
})
