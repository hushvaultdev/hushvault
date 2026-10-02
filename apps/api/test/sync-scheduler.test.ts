import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFER_MS, MAX_AUTO_RUNS_PER_ORG_PER_HOUR, MAX_RUNS_PER_TICK, OUTBOX_CLAIM_MS, SYNC_DEBOUNCE_MS, enqueueSyncForEnvironment, syncTick,
} from '../src/integrations/sync-scheduler'
import { MAX_SYNC_ATTEMPTS } from '../src/integrations/sync-engine'
import { call, createTestEnv, seedEnvironment, type TestEnv } from './helpers/env'
import { installFakeProvider, seedTarget, setupSyncWorld, type FakeProvider } from './helpers/sync-fixture'

let env: TestEnv
let provider: FakeProvider
let logged: string[]

beforeEach(() => {
  env = createTestEnv()
  provider = installFakeProvider()
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

const setAuto = (targetId: string, onChange: number, minutes: number | null = null) =>
  env.DB.prepare('UPDATE sync_targets SET sync_on_change = ?, schedule_minutes = ? WHERE id = ?').bind(onChange, minutes, targetId).run()
const outbox = async () => (await env.DB.prepare('SELECT * FROM sync_outbox ORDER BY created_at').all<Record<string, unknown>>()).results
const later = (ms: number) => new Date(Date.now() + ms)

describe('on-change outbox', () => {
  it('queues one coalesced row for an on-change target, none for targets without the flag', async () => {
    const w = await setupSyncWorld(env)
    expect(await enqueueSyncForEnvironment(env as never, w.envId)).toBe(0) // flag off
    await setAuto(w.targetId, 1)
    expect(await enqueueSyncForEnvironment(env as never, w.envId)).toBe(1)
    await enqueueSyncForEnvironment(env as never, w.envId) // coalesces into the same row
    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(/postgres|k-1/) // ids only
  })

  it('inheritance: a change in a parent environment queues targets of its children', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: 'a' } })
    const child = await seedEnvironment(env, w.projectId, 'child', w.envId)
    const childTarget = await seedTarget(env, { orgId: w.orgId, projectId: w.projectId, envId: child, connectionId: w.connectionId, userId: w.userId })
    await setAuto(childTarget, 1)
    expect(await enqueueSyncForEnvironment(env as never, w.envId)).toBe(1)
    expect((await outbox())[0]?.['target_id']).toBe(childTarget)
    // A change in the child does not queue the parent's target.
    await setAuto(w.targetId, 1)
    await env.DB.prepare('DELETE FROM sync_outbox').run()
    expect(await enqueueSyncForEnvironment(env as never, child)).toBe(1)
    expect((await outbox())[0]?.['target_id']).toBe(childTarget)
  })

  it('creating, editing and deleting a secret through the API queues the sync, and the tick pushes it after the debounce', async () => {
    const w = await setupSyncWorld(env, { secrets: {} })
    await setAuto(w.targetId, 1)
    const created = await call(env, 'POST', '/api/secrets', { token: w.token, json: { projectId: w.projectId, envId: w.envId, name: 'NEW_KEY', value: 'v-new-1' } })
    expect(created.status).toBe(201)
    expect(await outbox()).toHaveLength(1)

    // Not yet due: nothing runs.
    const early = await syncTick(env as never, new Date())
    expect(early.changeRuns).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)

    const tick = await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    expect(tick.changeRuns).toBe(1)
    expect(provider.remote.get('NEW_KEY')).toBe('v-new-1')
    const run = await env.DB.prepare('SELECT trigger, status FROM sync_runs').first<{ trigger: string; status: string }>()
    expect(run).toMatchObject({ trigger: 'change', status: 'succeeded' })
    expect((await outbox())[0]?.['done_at']).not.toBeNull()

    // Edit then delete: queue again, then the delete removes nothing unless the delete toggle is on.
    await call(env, 'PATCH', `/api/secrets/${created.body.data.id}`, { token: w.token, json: { value: 'v-new-2' } })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE done_at IS NULL').first<{ n: number }>())?.n).toBe(1)
    await syncTick(env as never, later(2 * SYNC_DEBOUNCE_MS + 2000))
    expect(provider.remote.get('NEW_KEY')).toBe('v-new-2')
    await call(env, 'DELETE', `/api/secrets/${created.body.data.id}`, { token: w.token })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE done_at IS NULL').first<{ n: number }>())?.n).toBe(1)
  })

  it('a stale claim (worker died mid-run) is picked up again; a fresh claim is respected', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    const claimedAt = new Date().toISOString()
    await env.DB.prepare('UPDATE sync_outbox SET claimed_at = ?').bind(claimedAt).run()
    expect((await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))).changeRuns).toBe(0) // another sweep owns it
    expect((await syncTick(env as never, later(OUTBOX_CLAIM_MS + SYNC_DEBOUNCE_MS + 1000))).changeRuns).toBe(1)
  })

  it('a target turned off or deleted before the sweep drops its row without running', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    await setAuto(w.targetId, 0)
    const tick = await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    expect(tick.changeRuns).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)
    expect((await outbox())[0]?.['done_at']).not.toBeNull()
  })

  it('a busy target keeps its row (single flight) and is not counted as run', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    const now = new Date().toISOString()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, started_at, lease_until) VALUES ('isr_busy', ?, 'manual', 'running', 1, '{}', ?, ?)")
      .bind(w.targetId, now, new Date(Date.now() + 600000).toISOString()).run()
    const tick = await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    expect(tick.changeRuns).toBe(0)
    expect((await outbox())[0]?.['done_at']).toBeNull()
    expect((await outbox())[0]?.['claimed_at']).toBeNull()
  })
})

describe('review fixes', () => {
  it('a change that lands while its row is being run is not lost: the row stays pending and runs again', async () => {
    const w = await setupSyncWorld(env, { secrets: { K: 'v1' } })
    await setAuto(w.targetId, 1)
    const t0 = new Date()
    await enqueueSyncForEnvironment(env as never, w.envId, t0)
    // A secret write happens while the claimed run is in flight (during the provider push).
    provider.script.push(async () => {
      await env.DB.prepare("UPDATE secrets SET updated_at = updated_at WHERE name = 'K'").run()
      await enqueueSyncForEnvironment(env as never, w.envId, new Date(Date.now() + 5 * 60_000))
      return undefined
    })
    const tick = await syncTick(env as never, new Date(t0.getTime() + SYNC_DEBOUNCE_MS + 1000))
    expect(tick.changeRuns).toBe(1)
    const row = (await outbox())[0]!
    expect(row['done_at']).toBeNull() // not completed: it is dirty
    expect(row['claimed_at']).toBeNull() // released for another pass
    // The next sweep after the debounce runs it again and completes it.
    const second = await syncTick(env as never, new Date(t0.getTime() + 10 * 60_000))
    expect(second.changeRuns).toBe(1)
    expect((await outbox())[0]?.['done_at']).not.toBeNull()
  })

  it('a schedule-only target with a crashed (expired-lease) run recovers on the next tick', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 0, 15)
    const old = new Date(Date.now() - 3_600_000).toISOString()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, started_at, lease_until) VALUES ('isr_dead', ?, 'schedule', 'running', 1, '{}', ?, ?)")
      .bind(w.targetId, old, old).run()
    const tick = await syncTick(env as never, new Date())
    expect(tick.scheduleRuns).toBe(1)
    expect((await env.DB.prepare("SELECT status FROM sync_runs WHERE id = 'isr_dead'").first<{ status: string }>())?.status).not.toBe('running')
  })

  it('the retry marker survives a run that never starts (provider module missing)', async () => {
    const w = await setupSyncWorld(env)
    const now = new Date()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, error_code, started_at, finished_at, next_retry_at) VALUES ('isr_f', ?, 'manual', 'failed', 1, '{}', 'PROVIDER_ERROR', ?, ?, ?)")
      .bind(w.targetId, new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 59_000).toISOString(), new Date(now.getTime() - 1000).toISOString()).run()
    await env.DB.prepare("UPDATE sync_targets SET provider = 'nonexistent-provider' WHERE id = ?").bind(w.targetId).run()
    const tick = await syncTick(env as never, now)
    expect(tick.retryRuns).toBe(0)
    expect((await env.DB.prepare("SELECT next_retry_at FROM sync_runs WHERE id = 'isr_f'").first<{ next_retry_at: string | null }>())?.next_retry_at).not.toBeNull()
  })

  it('a row whose run cannot start is pushed back, so it does not hog the window', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    await env.DB.prepare("UPDATE sync_targets SET provider = 'nonexistent-provider' WHERE id = ?").bind(w.targetId).run()
    const at = new Date(Date.now() + SYNC_DEBOUNCE_MS + 1000)
    await syncTick(env as never, at)
    const row = (await outbox())[0]!
    expect(row['claimed_at']).toBeNull()
    expect(Date.parse(row['due_at'] as string)).toBeGreaterThan(at.getTime())
  })

  it('a tick starts at most MAX_RUNS_PER_TICK runs; the rest wait for the next minute', async () => {
    const w = await setupSyncWorld(env, { secrets: { A: 'a' } })
    for (let i = 0; i < 7; i += 1) {
      const e = await seedEnvironment(env, w.projectId, `e${i}`)
      const tg = await seedTarget(env, { orgId: w.orgId, projectId: w.projectId, envId: e, connectionId: w.connectionId, userId: w.userId, resource: { scriptName: `w${i}` } })
      await setAuto(tg, 0, 15)
    }
    const tick = await syncTick(env as never, new Date())
    expect(tick.scheduleRuns).toBe(MAX_RUNS_PER_TICK)
    expect((await syncTick(env as never, new Date())).scheduleRuns).toBe(2)
  })

  it('re-activating a needs_attention on-change target by editing it catches up on missed changes', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await env.DB.prepare("UPDATE sync_targets SET status = 'needs_attention' WHERE id = ?").bind(w.targetId).run()
    expect(await enqueueSyncForEnvironment(env as never, w.envId)).toBe(0)
    const patched = await call(env, 'PATCH', `/api/integrations/targets/${w.targetId}`, { token: w.token, json: { resource: { scriptName: 'worker-b' } } })
    expect(patched.status).toBe(200)
    expect(patched.body.data.status).toBe('active')
    expect(await outbox()).toHaveLength(1)
  })

  it('old done outbox rows are purged', async () => {
    const w = await setupSyncWorld(env)
    const ancient = new Date(Date.now() - 3 * 86_400_000).toISOString()
    await env.DB.prepare('INSERT INTO sync_outbox (id, target_id, org_id, created_at, changed_at, due_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('iso_old', w.targetId, w.orgId, ancient, ancient, ancient, ancient).run()
    await syncTick(env as never, new Date())
    expect(await outbox()).toHaveLength(0)
  })
})

describe('scheduled reconcile', () => {
  it('runs when the interval has elapsed, not before, and not while a run is active', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 0, 15)
    const first = await syncTick(env as never, new Date())
    expect(first.scheduleRuns).toBe(1) // never ran: due now
    expect(provider.remote.size).toBe(2)
    expect((await syncTick(env as never, later(5 * 60_000))).scheduleRuns).toBe(0) // 5 min later
    expect((await syncTick(env as never, later(16 * 60_000))).scheduleRuns).toBe(1)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE trigger = 'schedule'").first<{ n: number }>())?.n).toBe(2)
  })

  it('targets in needs_attention are not scheduled', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 0, 15)
    await env.DB.prepare("UPDATE sync_targets SET status = 'needs_attention' WHERE id = ?").bind(w.targetId).run()
    expect((await syncTick(env as never, new Date())).scheduleRuns).toBe(0)
  })
})

describe('retries', () => {
  it('a killed/failed run is retried when next_retry_at passes, only once, and stops at the attempt cap', async () => {
    const w = await setupSyncWorld(env)
    provider.script.push(() => ({ ok: false, code: 'PROVIDER_ERROR' } as never))
    const { runSync } = await import('../src/integrations/sync-engine')
    const failed = await runSync(env as never, w.targetId, { trigger: 'manual', actorId: w.userId })
    expect(failed.status).toBe('failed')
    expect(failed.nextRetryAt).not.toBeNull()

    // Not yet due.
    expect((await syncTick(env as never, new Date())).retryRuns).toBe(0)
    const due = new Date(Date.parse(failed.nextRetryAt as string) + 1000)
    const tick = await syncTick(env as never, due)
    expect(tick.retryRuns).toBe(1)
    const runs = await env.DB.prepare('SELECT attempt, status, trigger FROM sync_runs ORDER BY started_at, attempt').all<{ attempt: number; status: string; trigger: string }>()
    expect(runs.results.map((r) => r.attempt)).toContain(2)
    expect(runs.results[runs.results.length - 1]?.status).toBe('succeeded')
    // The old failure's retry marker was consumed: a second tick does not run it again.
    expect((await syncTick(env as never, new Date(due.getTime() + 60_000))).retryRuns).toBe(0)
  })

  it('an old failure is not retried once a later run exists', async () => {
    const w = await setupSyncWorld(env)
    const now = new Date()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, error_code, started_at, finished_at, next_retry_at) VALUES ('isr_old', ?, 'manual', 'failed', 1, '{}', 'PROVIDER_ERROR', ?, ?, ?)")
      .bind(w.targetId, new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 59_000).toISOString(), new Date(now.getTime() - 1000).toISOString()).run()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, started_at, finished_at) VALUES ('isr_new', ?, 'manual', 'succeeded', 1, '{}', ?, ?)")
      .bind(w.targetId, new Date(now.getTime() - 30_000).toISOString(), new Date(now.getTime() - 29_000).toISOString()).run()
    expect((await syncTick(env as never, now)).retryRuns).toBe(0)
    expect(provider.pushCalls).toHaveLength(0)
  })

  it('a run at the attempt cap never retries and its marker is cleared', async () => {
    const w = await setupSyncWorld(env)
    const now = new Date()
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, error_code, started_at, finished_at, next_retry_at) VALUES ('isr_cap', ?, 'change', 'failed', ?, '{}', 'PROVIDER_ERROR', ?, ?, ?)")
      .bind(w.targetId, MAX_SYNC_ATTEMPTS, new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 59_000).toISOString(), new Date(now.getTime() - 1000).toISOString()).run()
    expect((await syncTick(env as never, now)).retryRuns).toBe(0)
    expect((await env.DB.prepare("SELECT next_retry_at FROM sync_runs WHERE id = 'isr_cap'").first<{ next_retry_at: string | null }>())?.next_retry_at).toBeNull()
  })
})

describe('limits and safety', () => {
  it('defers (does not drop) work when the organisation hit its automatic-run cap', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    const now = new Date()
    for (let i = 0; i < MAX_AUTO_RUNS_PER_ORG_PER_HOUR; i += 1) {
      await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, started_at, finished_at) VALUES (?, ?, 'schedule', 'succeeded', 1, '{}', ?, ?)")
        .bind(`isr_cap${i}`, w.targetId, now.toISOString(), now.toISOString()).run()
    }
    const tick = await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    expect(tick.deferred).toBe(1)
    expect(provider.pushCalls).toHaveLength(0)
    const row = (await outbox())[0]!
    expect(row['done_at']).toBeNull()
    expect(Date.parse(row['due_at'] as string)).toBeGreaterThan(Date.now() + DEFER_MS - 5000)
  })

  it('a provider failure on an automatic run becomes a failed run + needs_attention for auth errors, with audit rows by the system actor', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 1)
    await enqueueSyncForEnvironment(env as never, w.envId)
    provider.listError = 'PROVIDER_AUTH'
    const tick = await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    expect(tick.changeRuns).toBe(1)
    expect((await env.DB.prepare('SELECT status FROM sync_targets WHERE id = ?').bind(w.targetId).first<{ status: string }>())?.status).toBe('needs_attention')
    const audits = await env.DB.prepare("SELECT actor_type, action FROM audit_log WHERE action LIKE 'sync.run.%'").all<{ actor_type: string; action: string }>()
    expect(audits.results.length).toBeGreaterThan(0)
    expect(audits.results.every((a) => a.actor_type === 'system')).toBe(true)
    // A needs_attention target is no longer queued by changes.
    await env.DB.prepare('DELETE FROM sync_outbox').run()
    expect(await enqueueSyncForEnvironment(env as never, w.envId)).toBe(0)
  })

  it('no secret value or credential appears in the outbox, run rows, audit rows or logs', async () => {
    const w = await setupSyncWorld(env, { secrets: { TOKEN: 'value-CANARY-71c2' } })
    await setAuto(w.targetId, 1, 15)
    await enqueueSyncForEnvironment(env as never, w.envId)
    await syncTick(env as never, later(SYNC_DEBOUNCE_MS + 1000))
    const dump = JSON.stringify({
      outbox: await outbox(),
      runs: (await env.DB.prepare('SELECT * FROM sync_runs').all()).results,
      audit: (await env.DB.prepare('SELECT * FROM audit_log').all()).results,
      items: (await env.DB.prepare('SELECT * FROM sync_items').all()).results,
      logged,
    })
    expect(dump).not.toContain('CANARY')
  })

  it('a step that throws does not stop the others or the tick', async () => {
    const w = await setupSyncWorld(env)
    await setAuto(w.targetId, 0, 15)
    const real = env.DB.prepare.bind(env.DB)
    let broke = false
    env.DB.prepare = ((sql: string) => {
      if (!broke && sql.includes('FROM sync_outbox')) { broke = true; throw new Error('boom') }
      return real(sql)
    }) as never
    const tick = await syncTick(env as never, new Date())
    expect(tick.failures).toBe(1)
    expect(tick.scheduleRuns).toBe(1)
  })
})

describe('API: autoSync on targets', () => {
  it('accepts and returns autoSync on create and patch, validates the schedule values', async () => {
    const w = await setupSyncWorld(env)
    const make = (autoSync: unknown) => call(env, 'POST', '/api/integrations/targets', {
      token: w.token, json: { projectId: w.projectId, envId: w.envId, connectionId: w.connectionId, resource: { scriptName: 'w-new' }, autoSync },
    })
    expect((await make({ onChange: true, scheduleMinutes: 7 })).status).toBe(400)
    const patched = await call(env, 'PATCH', `/api/integrations/targets/${w.targetId}`, { token: w.token, json: { autoSync: { onChange: true, scheduleMinutes: 60 } } })
    expect(patched.status).toBe(200)
    expect(patched.body.data.autoSync).toEqual({ onChange: true, scheduleMinutes: 60 })
    const partial = await call(env, 'PATCH', `/api/integrations/targets/${w.targetId}`, { token: w.token, json: { autoSync: { scheduleMinutes: null } } })
    expect(partial.body.data.autoSync).toEqual({ onChange: true, scheduleMinutes: null })
    const list = await call(env, 'GET', '/api/integrations/targets', { token: w.token })
    expect(list.body.data[0].autoSync).toEqual({ onChange: true, scheduleMinutes: null })
  })
})
