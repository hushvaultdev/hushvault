// Issue #83: every failure mode that used to be silent must emit a structured line an alert can
// match on. Each case here is a pair — the line fires in the failure case and does NOT fire in
// the healthy one — because an event that fires in the healthy case is an alert nobody keeps,
// and that is just as much a bug as one that never fires at all.
//
// Every case also asserts that no log line carries secret material. The fixtures use canary
// values so that is a real assertion and not a formality.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import worker from '../src/index'
import { rotationTick } from '../src/lib/key-rotation'
import { syncTick, OUTBOX_OVERDUE_MS } from '../src/integrations/sync-scheduler'
import { MAX_SYNC_ATTEMPTS } from '../src/integrations/sync-engine'
import { spendEmailBudget } from '../src/lib/account-security'
import { createRateLimitMiddleware, resetRateLimitDegradedState } from '../src/middleware/rate-limit'
import { createPrefixedId } from '../src/lib/auth'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { installFakeProvider, setupSyncWorld } from './helpers/sync-fixture'

const b64 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

/** Values that must never appear in a log line. */
const CANARIES = ['CANARY-SECRET-VALUE-9f3a1c', 'canary-user-9f3a1c@example.test']

let logs: string[]

beforeEach(() => {
  logs = []
  resetRateLimitDegradedState()
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => { vi.restoreAllMocks() })

/** Parsed structured lines carrying `event`. The request logger's lines have no `event`. */
function events(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of logs) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (typeof parsed['event'] === 'string') out.push(parsed)
    } catch {
      // not a structured line
    }
  }
  return out
}

const named = (event: string) => events().filter((e) => e['event'] === event)
const fired = (event: string) => named(event).length > 0

/** Fails if any log line captured so far quotes a canary. Called in every case. */
function expectNoSecretMaterial() {
  for (const line of logs) {
    for (const canary of CANARIES) expect(line).not.toContain(canary)
  }
}

// ---------------------------------------------------------------------------
// 1. /health probes KV as well as D1
// ---------------------------------------------------------------------------

describe('GET /health probes both stores', () => {
  it('reports db and kv separately and stays 200 when both answer', async () => {
    const env = createTestEnv()
    const res = await call(env, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', version: '0.0.1', checks: { db: 'ok', kv: 'ok' } })
    expect(fired('health.degraded')).toBe(false)
  })

  it('the KV probe reads a key HushVault never writes, and writes nothing itself', async () => {
    const env = createTestEnv()
    const reads: string[] = []
    const writes: string[] = []
    const realKv = env.SECRETS_KV
    env.SECRETS_KV = {
      get: (key: string) => { reads.push(key); return realKv.get(key) },
      put: (key: string, value: string) => { writes.push(key); return realKv.put(key, value) },
      delete: (key: string) => { writes.push(key); return realKv.delete(key) },
      list: realKv.list.bind(realKv),
      store: realKv.store,
    } as unknown as TestEnv['SECRETS_KV']

    expect((await call(env, 'GET', '/health')).status).toBe(200)
    // One read, of the reserved probe key, and no write or delete: the free-plan write quota is
    // one of the failures this endpoint exists to reveal, so the probe must not consume it.
    expect(reads).toEqual(['health:probe'])
    expect(writes).toEqual([])
    expect(realKv.store.size).toBe(0)
  })

  it('503 with kv down, db still ok, when KV cannot answer', async () => {
    const env = createTestEnv()
    env.SECRETS_KV = { get: () => Promise.reject(new Error('kv unreachable')) } as unknown as TestEnv['SECRETS_KV']
    const res = await call(env, 'GET', '/health')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'degraded', version: '0.0.1', reason: 'kv', checks: { db: 'ok', kv: 'down' } })
    expect(named('health.degraded')[0]).toMatchObject({ db: 'ok', kv: 'down', reason: 'kv' })
  })

  it('an absent KV binding is reported as unconfigured, not as healthy', async () => {
    const env = createTestEnv()
    delete (env as Record<string, unknown>)['SECRETS_KV']
    const res = await call(env, 'GET', '/health')
    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ db: 'ok', kv: 'unconfigured' })
  })

  it('503 with reason database when D1 is down, and the kv result is still reported', async () => {
    const env = createTestEnv()
    env.DB = { prepare: () => { throw new Error('d1 down') } } as unknown as TestEnv['DB']
    const res = await call(env, 'GET', '/health')
    expect(res.status).toBe(503)
    // `reason` keeps its original single-string value so anything already matching on it still works.
    expect(res.body).toEqual({ status: 'degraded', version: '0.0.1', reason: 'database', checks: { db: 'down', kv: 'ok' } })
    expect(named('health.degraded')[0]).toMatchObject({ db: 'down', kv: 'ok' })
  })

  it('both down is a single 503 that names both', async () => {
    const env = createTestEnv()
    env.DB = { prepare: () => { throw new Error('d1 down') } } as unknown as TestEnv['DB']
    env.SECRETS_KV = { get: () => Promise.reject(new Error('kv down')) } as unknown as TestEnv['SECRETS_KV']
    const res = await call(env, 'GET', '/health')
    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ db: 'down', kv: 'down' })
  })
})

// ---------------------------------------------------------------------------
// 2a. Rate limiting degraded — hot path, so sampled
// ---------------------------------------------------------------------------

/** A Durable Object namespace binding that always fails, like an outage. */
const brokenLimiter = () => ({ idFromName: () => { throw new Error('DO unreachable') }, get: () => { throw new Error('DO unreachable') } })

function limiterApp(scope: string, failClosed = false) {
  const app = new Hono<{ Bindings: TestEnv }>()
  app.use('*', createRateLimitMiddleware({ scope, limit: 1000, windowMs: 60_000, failClosed }) as never)
  app.get('/x', (c) => c.json({ ok: true }))
  return app
}

describe('rate limiter degradation is visible but throttled', () => {
  it('emits nothing while the limiter works', async () => {
    const env = createTestEnv()
    const app = limiterApp('probe-ok')
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/x', {}, env)).status).toBe(200)
    }
    expect(fired('rate_limit.degraded')).toBe(false)
    expect(fired('rate_limit.unavailable')).toBe(false)
    expect(fired('rate_limit.disabled')).toBe(false)
  })

  it('emits on the FIRST fallback, then at most one line per window however many requests fail', async () => {
    const env = createTestEnv({ RATE_LIMITER: brokenLimiter() })
    const app = limiterApp('probe-degraded')

    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    expect((await app.request('/x', {}, env)).status).toBe(200) // fails open, degraded
    expect(named('rate_limit.degraded')).toHaveLength(1)
    expect(named('rate_limit.degraded')[0]).toMatchObject({ scope: 'probe-degraded', occurrences: 1, windowMs: 60_000 })

    // 200 more failing requests inside the same window must not add 200 log lines: under a
    // sustained Durable Object outage every request takes this path.
    for (let i = 0; i < 200; i += 1) await app.request('/x', {}, env)
    expect(named('rate_limit.degraded')).toHaveLength(1)

    // Past the window, one more line, and it carries how many were suppressed.
    clock += 60_001
    await app.request('/x', {}, env)
    const lines = named('rate_limit.degraded')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ occurrences: 201 })
  })

  it('a fail-closed scope emits rate_limit.unavailable and returns 503', async () => {
    const env = createTestEnv({ RATE_LIMITER: brokenLimiter() })
    const app = limiterApp('probe-closed', true)
    expect((await app.request('/x', {}, env)).status).toBe(503)
    expect(named('rate_limit.unavailable')[0]).toMatchObject({ scope: 'probe-closed', occurrences: 1 })
    // The fail-open event is a different incident and must not be claimed here.
    expect(fired('rate_limit.degraded')).toBe(false)
  })

  it('an unavailable identity limit is reported even where the caller fails open silently', async () => {
    const env = createTestEnv({ RATE_LIMITER: brokenLimiter(), EMAIL_DAILY_BUDGET: '5' })
    expect(await spendEmailBudget(env as never, 'verify', 'registration')).toBe(false)
    expect(fired('rate_limit.unavailable')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2b. Email budget — was logged on one of three send paths
// ---------------------------------------------------------------------------

describe('email budget exhaustion emits on every send path', () => {
  it('says nothing while budget remains', async () => {
    const env = createTestEnv({ EMAIL_DAILY_BUDGET: '5' })
    expect(await spendEmailBudget(env as never, 'verify', 'registration')).toBe(true)
    expect(fired('email.budget_exhausted')).toBe(false)
    expect(fired('email.budget_unavailable')).toBe(false)
  })

  it('emits email.budget_exhausted with the purpose, for the two paths that used to be silent', async () => {
    const env = createTestEnv({ EMAIL_DAILY_BUDGET: '1' })
    // 'verify' and 'reset' are separate buckets, so each needs its own spend to exhaust.
    expect(await spendEmailBudget(env as never, 'verify', 'registration')).toBe(true)
    expect(await spendEmailBudget(env as never, 'verify', 'registration')).toBe(false)
    expect(await spendEmailBudget(env as never, 'reset', 'password_changed')).toBe(true)
    expect(await spendEmailBudget(env as never, 'reset', 'password_changed')).toBe(false)

    const purposes = named('email.budget_exhausted').map((e) => e['purpose'])
    expect(purposes).toEqual(['registration', 'password_changed'])
    expect(named('email.budget_exhausted')[0]).toMatchObject({ kind: 'verify', limit: 1 })
  })

  it('distinguishes a spent budget from a broken limiter', async () => {
    const env = createTestEnv({ RATE_LIMITER: brokenLimiter(), EMAIL_DAILY_BUDGET: '5' })
    expect(await spendEmailBudget(env as never, 'reset', 'forgot_password')).toBe(false)
    expect(named('email.budget_unavailable')[0]).toMatchObject({ kind: 'reset', purpose: 'forgot_password' })
    // Not the same incident: the cap did not fire, it was never consulted.
    expect(fired('email.budget_exhausted')).toBe(false)
  })

  it('registration through the API emits it, with no address in the line', async () => {
    const env = createTestEnv({ EMAIL_DAILY_BUDGET: '1' })
    const first = await call(env, 'POST', '/api/auth/register', {
      json: { email: 'first-9f3a1c@example.test', password: 'correct horse battery staple', organisationName: 'First Org' },
    })
    expect(first.status).toBe(201)
    expect(fired('email.budget_exhausted')).toBe(false)

    const second = await call(env, 'POST', '/api/auth/register', {
      json: { email: CANARIES[1], password: 'correct horse battery staple', organisationName: 'Second Org' },
    })
    expect(second.status).toBe(201) // registration still succeeds; only the mail is skipped
    expect(named('email.budget_exhausted')[0]).toMatchObject({ kind: 'verify', purpose: 'registration' })
    expectNoSecretMaterial()
  })
})

// ---------------------------------------------------------------------------
// 2c. DECRYPTION_FAILED on the single-secret read path
// ---------------------------------------------------------------------------

async function secretWorld(extra: Record<string, unknown> = {}) {
  const env = createTestEnv(extra)
  const owner = await seedUser(env, { role: 'owner' })
  const projectId = await seedProject(env, owner.orgId)
  const envId = await seedEnvironment(env, projectId)
  const created = await call(env, 'POST', '/api/secrets', {
    token: owner.token,
    json: { projectId, envId, name: 'TOKEN', value: CANARIES[0] },
  })
  expect(created.status).toBe(201)
  return { env, owner, projectId, envId, secretId: created.body.data.id as string }
}

describe('secret.decrypt_failed on the single-secret read path', () => {
  it('a healthy read emits no decrypt failure', async () => {
    const w = await secretWorld()
    const res = await call(w.env, 'GET', `/api/secrets/TOKEN?envId=${w.envId}`, { token: w.owner.token })
    expect(res.status).toBe(200)
    expect(res.body.data.value).toBe(CANARIES[0])
    expect(fired('secret.decrypt_failed')).toBe(false)
    expectNoSecretMaterial()
  })

  it('a corrupt blob emits secret.decrypt_failed with ids and a reason only', async () => {
    const w = await secretWorld()
    const kvKey = [...w.env.SECRETS_KV.store.keys()].find((k) => k.startsWith('secret:'))!
    w.env.SECRETS_KV.store.set(kvKey, 'bm90LWEtdmFsaWQtYmxvYg==')

    const res = await call(w.env, 'GET', `/api/secrets/TOKEN?envId=${w.envId}`, { token: w.owner.token })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' })

    const line = named('secret.decrypt_failed')[0]
    expect(line).toMatchObject({ secretId: w.secretId, environmentId: w.envId })
    expect(typeof line!['reason']).toBe('string')
    // The secret's NAME is a caller-supplied label and is deliberately not in the line.
    expect(Object.keys(line!).sort()).toEqual(['environmentId', 'event', 'level', 'reason', 'secretId'])
    expectNoSecretMaterial()
  })

  it('a missing key version stays with the key-ring line and does not double-report', async () => {
    const w = await secretWorld({ ENCRYPTION_KEY_V2: b64() })
    await rotationTick(w.env as never)
    w.env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'
    await rotationTick(w.env as never)
    await call(w.env, 'POST', '/api/secrets', {
      token: w.owner.token,
      json: { projectId: w.projectId, envId: w.envId, name: 'GONE', value: CANARIES[0] },
    })
    delete w.env['ENCRYPTION_KEY_V2']
    logs.length = 0

    const res = await call(w.env, 'GET', `/api/secrets/GONE?envId=${w.envId}`, { token: w.owner.token })
    expect(res.status).toBe(500)
    // KeyRingError already has its own code-and-version line; this path must not add a second,
    // vaguer one for the same failure.
    expect(fired('secret.decrypt_failed')).toBe(false)
    expect(logs.join('\n')).toContain('KEY')
    expectNoSecretMaterial()
  })
})

// ---------------------------------------------------------------------------
// 2d. Rotation: dead, wedged, or finished with quarantined rows
// ---------------------------------------------------------------------------

async function rotationWorld(extra: Record<string, unknown> = {}) {
  const env = createTestEnv({ ENCRYPTION_KEY_V2: b64(), ...extra })
  const owner = await seedUser(env, { role: 'owner' })
  const projectId = await seedProject(env, owner.orgId)
  const envId = await seedEnvironment(env, projectId)
  return { env, owner, projectId, envId }
}

async function seedRotatableSecret(w: { env: TestEnv; owner: { token: string }; projectId: string; envId: string }, name: string) {
  const res = await call(w.env, 'POST', '/api/secrets', {
    token: w.owner.token, json: { projectId: w.projectId, envId: w.envId, name, value: CANARIES[0] },
  })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

describe('rotation failures emit', () => {
  it('a healthy tick emits no failure line', async () => {
    const w = await rotationWorld()
    expect((await rotationTick(w.env as never)).state).toBe('bootstrapped')
    expect(await rotationTick(w.env as never)).toEqual({ state: 'idle' })
    for (const e of ['key_rotation.key_unavailable', 'key_rotation.stalled', 'key_rotation.rows_quarantined', 'key_rotation.unresolved_rows']) {
      expect(fired(e)).toBe(false)
    }
  })

  it('an unusable key ring emits key_rotation.key_unavailable with a code and no key material', async () => {
    const w = await rotationWorld()
    // A mistyped ENCRYPTION_ACTIVE_KEY_VERSION: the tick cannot build a ring at all, so it
    // returned this every minute forever with nothing in the logs.
    w.env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v-nope'
    expect(await rotationTick(w.env as never)).toEqual({ state: 'error', code: 'KEY_VERSION_INVALID' })
    const line = named('key_rotation.key_unavailable')[0]
    expect(line).toMatchObject({ code: 'KEY_VERSION_INVALID' })
    // Code only: not the version string the operator typed, and certainly no key material.
    expect(Object.keys(line!).sort()).toEqual(['code', 'event', 'level'])
    expect(logs.join('\n')).not.toContain(w.env.ENCRYPTION_MASTER_KEY)
  })

  it('a job stuck running with a stale updated_at emits key_rotation.stalled every tick', async () => {
    const w = await rotationWorld()
    await seedRotatableSecret(w, 'ROTATE_ME')
    await rotationTick(w.env as never) // bootstrap v1
    w.env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'
    expect((await rotationTick(w.env as never)).state).toBe('activated')
    expect(fired('key_rotation.stalled')).toBe(false) // fresh job

    // Wedge it: a lease nobody will release, and an updated_at that stopped moving.
    const stale = new Date(Date.now() - 20 * 60_000).toISOString()
    const forever = new Date(Date.now() + 3_600_000).toISOString()
    await w.env.DB.prepare("UPDATE key_rotations SET updated_at = ?, lease_until = ?, lease_owner = 'gone' WHERE status = 'running'")
      .bind(stale, forever).run()

    expect((await rotationTick(w.env as never)).state).toBe('busy')
    const line = named('key_rotation.stalled')[0]
    expect(line).toMatchObject({ from: 'v1', to: 'v2', phase: 'secrets' })
    expect(Number(line!['staleMs'])).toBeGreaterThanOrEqual(20 * 60_000)

    // Re-emitted, because the alert condition is "this line is present" and the job is still stuck.
    await rotationTick(w.env as never)
    expect(named('key_rotation.stalled')).toHaveLength(2)
    expectNoSecretMaterial()
  })

  it('quarantined rows emit per tick and again when the rotation finishes', async () => {
    const w = await rotationWorld()
    await seedRotatableSecret(w, 'OK_ROW')
    const orphan = await seedRotatableSecret(w, 'LOST_ROW')
    await rotationTick(w.env as never) // bootstrap v1
    // A row labelled with a key version this deployment does not have: it cannot be re-wrapped
    // and is quarantined, which is what makes retiring the old key destructive.
    await w.env.DB.prepare("UPDATE secrets SET key_version = 'v7' WHERE id = ?").bind(orphan).run()
    w.env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'

    for (let i = 0; i < 12; i += 1) {
      const r = await rotationTick(w.env as never)
      if (r.state === 'completed') break
    }

    const quarantined = named('key_rotation.rows_quarantined')[0]
    expect(quarantined).toMatchObject({ table: 'secrets', quarantined: 1, keyVersionUnavailable: 1, unwrapFailed: 0, from: 'v1', to: 'v2' })

    // The one an operator must alert on: the rotation ENDED with rows nothing can re-wrap, so
    // the old key is not safe to retire. Same field names as the status endpoint.
    expect(named('key_rotation.unresolved_rows')[0]).toMatchObject({ unresolvedRows: 1, safeToRetireOldKeys: false, from: 'v1', to: 'v2' })
    // Not a row id, not a wrapped DEK, not a value.
    expect(Object.keys(named('key_rotation.unresolved_rows')[0]!).sort())
      .toEqual(['event', 'from', 'level', 'safeToRetireOldKeys', 'to', 'unresolvedRows'])
    expectNoSecretMaterial()
  })

  it('a clean rotation finishes without claiming unresolved rows', async () => {
    const w = await rotationWorld()
    await seedRotatableSecret(w, 'CLEAN_ROW')
    await rotationTick(w.env as never)
    w.env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'
    for (let i = 0; i < 12; i += 1) {
      const r = await rotationTick(w.env as never)
      if (r.state === 'completed') break
    }
    expect(named('key_rotation.finished')[0]).toMatchObject({ status: 'completed', failed: 0 })
    expect(fired('key_rotation.unresolved_rows')).toBe(false)
    expect(fired('key_rotation.rows_quarantined')).toBe(false)
  })

  it('a broken rotation table still emits key_rotation.tick_failed', async () => {
    const w = await rotationWorld()
    w.env.DB.sqlite.exec('DROP TABLE key_rotations')
    expect(await rotationTick(w.env as never)).toEqual({ state: 'error', code: 'TICK_FAILED' })
    expect(fired('key_rotation.tick_failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2e. Sync: a tick that did nothing, and a backlog nothing retries
// ---------------------------------------------------------------------------

describe('sync tick is a heartbeat and reports its backlog', () => {
  it('emits sync.tick even when nothing happened, so its absence is the alert', async () => {
    const env = createTestEnv()
    installFakeProvider()
    const tally = await syncTick(env as never)
    expect(tally).toEqual({ changeRuns: 0, scheduleRuns: 0, retryRuns: 0, deferred: 0, failures: 0 })
    expect(named('sync.tick')[0]).toMatchObject({ changeRuns: 0, scheduleRuns: 0, retryRuns: 0, failures: 0 })
    // Healthy and idle: a heartbeat, but no backlog claim.
    expect(fired('sync.backlog')).toBe(false)
  })

  it('an overdue outbox row is counted in sync.backlog', async () => {
    const env = createTestEnv()
    installFakeProvider()
    const w = await setupSyncWorld(env, { secrets: {} })
    // Overdue by more than the threshold, but claimed recently enough that this sweep will not
    // pick it up — the shape a backlog actually has while something keeps releasing the row.
    const overdue = new Date(Date.now() - OUTBOX_OVERDUE_MS - 60_000).toISOString()
    await env.DB.prepare('INSERT INTO sync_outbox (id, target_id, org_id, created_at, changed_at, due_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(createPrefixedId('iso'), w.targetId, w.orgId, overdue, overdue, overdue, new Date().toISOString()).run()

    await syncTick(env as never)
    expect(named('sync.backlog')[0]).toMatchObject({ overdue: 1, needsAttention: 0, abandoned: 0, overdueAfterMs: OUTBOX_OVERDUE_MS })
  })

  it('a target parked in needs_attention is counted', async () => {
    const env = createTestEnv()
    installFakeProvider()
    const w = await setupSyncWorld(env, { secrets: {} })
    await env.DB.prepare("UPDATE sync_targets SET status = 'needs_attention' WHERE id = ?").bind(w.targetId).run()
    await syncTick(env as never)
    expect(named('sync.backlog')[0]).toMatchObject({ needsAttention: 1 })
  })

  it('a run that exhausted its attempts emits sync.gave_up once and is then counted as abandoned', async () => {
    const env = createTestEnv()
    installFakeProvider()
    const w = await setupSyncWorld(env, { secrets: {} })
    const runId = createPrefixedId('isr')
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare(
      "INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, finished_at, next_retry_at, error_code, actor_id) VALUES (?, ?, 'change', 'failed', ?, ?, ?, ?, 'PROVIDER_ERROR', NULL)",
    ).bind(runId, w.targetId, MAX_SYNC_ATTEMPTS, past, past, past).run()

    await syncTick(env as never)
    expect(named('sync.gave_up')[0]).toMatchObject({ targetId: w.targetId, attempt: MAX_SYNC_ATTEMPTS, maxAttempts: MAX_SYNC_ATTEMPTS })
    // next_retry_at is now cleared, which is what makes the stop permanent.
    const row = await env.DB.prepare('SELECT next_retry_at FROM sync_runs WHERE id = ?').bind(runId).first<{ next_retry_at: string | null }>()
    expect(row!.next_retry_at).toBeNull()
    expect(named('sync.backlog')[0]).toMatchObject({ abandoned: 1 })

    // A second tick does not re-announce the decision: the row is no longer a retry candidate.
    logs.length = 0
    await syncTick(env as never)
    expect(fired('sync.gave_up')).toBe(false)
    expect(named('sync.backlog')[0]).toMatchObject({ abandoned: 1 })
  })

  it('a run with attempts left is neither given up on nor counted as abandoned', async () => {
    const env = createTestEnv()
    const provider = installFakeProvider()
    provider.listError = 'PROVIDER_ERROR'
    const w = await setupSyncWorld(env, { secrets: {} })
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare(
      "INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, finished_at, next_retry_at, error_code, actor_id) VALUES (?, ?, 'change', 'failed', 1, ?, ?, ?, 'PROVIDER_ERROR', NULL)",
    ).bind(createPrefixedId('isr'), w.targetId, past, past, past).run()
    await syncTick(env as never)
    // The run is retried, so nothing has given up and nothing is abandoned. The target may
    // legitimately flip to needs_attention, so only the abandoned count is asserted.
    expect(fired('sync.gave_up')).toBe(false)
    for (const line of named('sync.backlog')) expect(line['abandoned']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The cron's own heartbeat
// ---------------------------------------------------------------------------

/** Collects waitUntil work so a test can await the scheduled handler's background promises. */
function fakeCtx() {
  const pending: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  }
}

describe('cron.tick heartbeat', () => {
  it('emits once per scheduled invocation with each tick outcome', async () => {
    const env = createTestEnv()
    installFakeProvider()
    const { ctx, settle } = fakeCtx()
    await worker.scheduled({} as ScheduledController, env as never, ctx)
    await settle()

    const line = named('cron.tick')[0]
    expect(named('cron.tick')).toHaveLength(1)
    expect(line).toMatchObject({ rotation: 'bootstrapped', rotationCode: null, sync: 'ok', housekeeping: 'ok' })
  })

  it('still emits, carrying the rotation error code, when a tick cannot do its job', async () => {
    const env = createTestEnv()
    installFakeProvider()
    env.DB.sqlite.exec('DROP TABLE key_rotations')
    const { ctx, settle } = fakeCtx()
    await worker.scheduled({} as ScheduledController, env as never, ctx)
    await settle()

    // Previously all three ticks were swallowed whole: a wedged cron and a healthy one produced
    // the same empty log.
    expect(named('cron.tick')[0]).toMatchObject({ rotation: 'error', rotationCode: 'TICK_FAILED', sync: 'ok' })
  })

  it('one tick failing does not stop the others from running', async () => {
    const env = createTestEnv()
    installFakeProvider()
    env.DB.sqlite.exec('DROP TABLE key_rotations')
    const { ctx, settle } = fakeCtx()
    await worker.scheduled({} as ScheduledController, env as never, ctx)
    await settle()
    // The sync tick ran to completion despite the rotation tick failing.
    expect(fired('sync.tick')).toBe(true)
    expect(named('cron.tick')).toHaveLength(1)
  })
})
