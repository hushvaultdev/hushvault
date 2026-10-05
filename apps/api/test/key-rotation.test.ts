import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecretWithRing, encryptSecretWithRing, loadKeyRing, makeKeyCheck, type KeyRing } from '../src/crypto/envelope'
import { BOOTSTRAP_RETRY_MS, rotationTick, type TickResult } from '../src/lib/key-rotation'
import { createPrefixedId } from '../src/lib/auth'
import { encryptCredentialWithRing } from '../src/crypto/envelope'
import { readCredential } from '../src/lib/integration-credentials'
import { createTestEnv, seedProject, seedEnvironment, seedUser, type TestEnv } from './helpers/env'

const b64 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

type Ctx = { env: TestEnv; projectId: string; envId: string; orgId: string }

async function setup(opts: { v2?: boolean } = {}): Promise<Ctx> {
  const env = createTestEnv(opts.v2 === false ? {} : { ENCRYPTION_KEY_V2: b64() })
  const owner = await seedUser(env, { role: 'owner' })
  const projectId = await seedProject(env, owner.orgId)
  const envId = await seedEnvironment(env, projectId)
  return { env, projectId, envId, orgId: owner.orgId }
}

function ringOf(env: TestEnv, active: string): KeyRing {
  return loadKeyRing({ ...(env as unknown as { ENCRYPTION_MASTER_KEY: string }), ENCRYPTION_ACTIVE_KEY_VERSION: active })
}

/** Insert `n` secrets encrypted under `version` with real KV blobs. */
async function seedMany(ctx: Ctx, n: number, version = 'v1') {
  const ring = ringOf(ctx.env, version)
  const expected = new Map<string, string>() // KV key -> plaintext
  const now = new Date().toISOString()
  for (let i = 0; i < n; i += 1) {
    const id = createPrefixedId('sec')
    const value = `value-${i}-${crypto.randomUUID()}`
    const w = await encryptSecretWithRing(value, ring, { projectId: ctx.projectId, envId: ctx.envId, secretId: id })
    await ctx.env.SECRETS_KV.put(`secret:${id}`, w.encryptedValue)
    await ctx.env.DB.prepare(
      'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, enc_version, is_computed, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 2, 0, ?, ?, ?)',
    ).bind(id, ctx.projectId, ctx.envId, `S_${i}`, w.wrappedDek, w.keyVersion, '[]', now, now).run()
    expected.set(`secret:${id}`, value)
  }
  return expected
}

type Row = { id: string; secret_id: string; project_id: string; env_id: string; wrapped_dek: string; key_version: string; enc_version: number }

/** The central invariant: every row decrypts to its original value through the full ring. */
async function assertAllDecryptable(ctx: Ctx, expected: Map<string, string>) {
  const ring = ringOf(ctx.env, 'v2')
  const rows = (await ctx.env.DB.prepare('SELECT id, id AS secret_id, project_id, env_id, wrapped_dek, key_version, enc_version FROM secrets').all<Row>())
    .results.map((r) => ({ kv: `secret:${r.id}`, ...r }))
  expect(rows.length).toBe(expected.size)
  for (const r of rows) {
    const blob = await ctx.env.SECRETS_KV.get(r.kv)
    expect(blob).not.toBeNull()
    const plain = await decryptSecretWithRing(blob as string, r.wrapped_dek, r.key_version, ring, { projectId: r.project_id, envId: r.env_id, secretId: r.secret_id }, r.enc_version)
    expect(plain).toBe(expected.get(r.kv))
  }
}

async function versionCounts(ctx: Ctx) {
  const out: Record<string, number> = {}
  for (const t of ['secrets', 'integration_connections']) {
    const { results } = await ctx.env.DB.prepare(`SELECT key_version AS v, count(*) AS n FROM ${t} GROUP BY key_version`).all<{ v: string; n: number }>()
    for (const r of results) out[`${t}:${r.v}`] = r.n
  }
  return out
}

async function runToEnd(env: TestEnv, opts: { batchSize?: number; maxTicks?: number } = {}) {
  const results: TickResult[] = []
  for (let i = 0; i < (opts.maxTicks ?? 200); i += 1) {
    const r = await rotationTick(env as never, { batchSize: opts.batchSize ?? 100 })
    results.push(r)
    if (r.state === 'completed' || r.state === 'failed' || r.state === 'error' || r.state === 'idle') break
  }
  return results
}

function activate(env: TestEnv, version: string) {
  env['ENCRYPTION_ACTIVE_KEY_VERSION'] = version
}

/** Wrap D1 so a test can fail or intercept batches (a "crash" before or after the commit). */
function instrument(env: TestEnv, hook: (n: number, run: () => Promise<unknown>) => Promise<unknown>) {
  const real = env.DB
  let n = 0
  env.DB = {
    prepare: (sql: string) => real.prepare(sql),
    batch: (stmts: Parameters<typeof real.batch>[0]) => {
      n += 1
      return hook(n, () => real.batch(stmts)) as ReturnType<typeof real.batch>
    },
  } as unknown as TestEnv['DB']
  return () => { env.DB = real }
}

describe('key rotation engine', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)) })
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('bootstraps the active key once, then idles with exactly two reads', async () => {
    const ctx = await setup()
    expect((await rotationTick(ctx.env as never)).state).toBe('bootstrapped')
    const reads: string[] = []
    const real = ctx.env.DB
    ctx.env.DB = { prepare: (sql: string) => { reads.push(sql); return real.prepare(sql) }, batch: real.batch.bind(real) } as unknown as TestEnv['DB']
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'idle' })
    expect(reads).toHaveLength(2)
    expect(reads.every((q) => /LIMIT 1/.test(q) && /encryption_keys|key_rotations/.test(q))).toBe(true)
  })

  it('rotates every secret row v1 -> v2 without touching KV, then finds nothing more to do', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 250)
    const kvBefore = new Map([...ctx.env.SECRETS_KV.store].filter(([k]) => k.startsWith('secret')))
    await rotationTick(ctx.env as never) // bootstrap v1
    activate(ctx.env, 'v2')

    const results = await runToEnd(ctx.env, { batchSize: 100 })
    expect(results[0]).toMatchObject({ state: 'activated', from: 'v1', to: 'v2' })
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 0 })

    expect(await versionCounts(ctx)).toEqual({ 'secrets:v2': 250 })
    for (const [k, v] of kvBefore) expect(ctx.env.SECRETS_KV.store.get(k)).toBe(v) // KV byte-identical
    await assertAllDecryptable(ctx, expected)

    const keys = await ctx.env.DB.prepare('SELECT version, status FROM encryption_keys ORDER BY version').all<{ version: string; status: string }>()
    expect(keys.results).toEqual([{ version: 'v1', status: 'decrypt_only' }, { version: 'v2', status: 'active' }])

    // Second run: nothing to do and zero UPDATEs.
    let updates = 0
    const real = ctx.env.DB
    ctx.env.DB = { prepare: (sql: string) => { if (/^UPDATE/i.test(sql)) updates += 1; return real.prepare(sql) }, batch: real.batch.bind(real) } as unknown as TestEnv['DB']
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'idle' })
    expect(updates).toBe(0)
  })

  it('writes started and completed audit events to every organisation', async () => {
    const ctx = await setup()
    await seedUser(ctx.env, { role: 'owner' }) // second org
    await seedMany(ctx, 3)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await runToEnd(ctx.env)
    const { results } = await ctx.env.DB.prepare("SELECT action, count(*) AS n FROM audit_log WHERE actor_type = 'system' GROUP BY action ORDER BY action").all<{ action: string; n: number }>()
    expect(results).toEqual([
      { action: 'key.rotation.completed', n: 2 },
      { action: 'key.rotation.started', n: 2 },
      { action: 'key.version.registered', n: 2 },
    ])
  })

  it('stays decryptable at every step across randomized crashes before and after each commit', async () => {
    for (let seed = 0; seed < 6; seed += 1) {
      const ctx = await setup()
      const expected = await seedMany(ctx, 40)
      await rotationTick(ctx.env as never)
      activate(ctx.env, 'v2')
      const restore = instrument(ctx.env, async (n, run) => {
        const crash = (n + seed) % 3 === 0
        const mode = (n + seed) % 2 === 0 ? 'before' : 'after'
        if (crash && mode === 'before') throw new Error('simulated crash')
        const out = await run()
        if (crash && mode === 'after') throw new Error('simulated crash after commit')
        return out
      })
      let completed = false
      for (let i = 0; i < 80 && !completed; i += 1) {
        const r = await rotationTick(ctx.env as never, { batchSize: 7, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 200)) })
        await assertAllDecryptable(ctx, expected)
        completed = r.state === 'completed'
      }
      restore()
      expect(completed).toBe(true)
      expect(await versionCounts(ctx)).toEqual({ 'secrets:v2': 40 })
    }
  })

  it('a concurrent PATCH (new DEK) makes the CAS a no-op and the row stays readable', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 5)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never) // activate
    const ring = ringOf(ctx.env, 'v2')
    let raced = false
    const restore = instrument(ctx.env, async (_n, run) => {
      if (!raced) {
        raced = true
        // A PATCH lands after the job read its candidates: new value under the active key.
        const row = await (ctx.env.DB as TestEnv['DB']).prepare("SELECT id FROM secrets WHERE name = 'S_0'").first<{ id: string }>()
        const w = await encryptSecretWithRing('patched', ring, { projectId: ctx.projectId, envId: ctx.envId, secretId: row!.id })
        await ctx.env.SECRETS_KV.put(`secret:${row!.id}`, w.encryptedValue)
        await ctx.env.DB.prepare('UPDATE secrets SET wrapped_dek = ?, key_version = ? WHERE id = ?').bind(w.wrappedDek, 'v2', row!.id).run()
        expected.set(`secret:${row!.id}`, 'patched')
      }
      return run()
    })
    // Restore after the first batch so the race hook only fires once.
    const first = await rotationTick(ctx.env as never, { batchSize: 100 })
    restore()
    expect(first.state).toBe('progress')
    if (first.state === 'progress') expect(first.skipped).toBeGreaterThanOrEqual(1)
    await runToEnd(ctx.env)
    await assertAllDecryptable(ctx, expected)
  })

  it('refuses to activate a mistyped key (check value mismatch) and changes nothing', async () => {
    const ctx = await setup()
    await seedMany(ctx, 3)
    await rotationTick(ctx.env as never)
    // v2 was registered earlier with a different key than the one now deployed.
    const real = ringOf(ctx.env, 'v2')
    await ctx.env.DB.prepare("INSERT INTO encryption_keys (version, check_value, status, created_at) VALUES ('v2', ?, 'decrypt_only', ?)")
      .bind(await makeKeyCheck(await real.getKey('v2')), new Date().toISOString()).run()
    ctx.env['ENCRYPTION_KEY_V2'] = b64() // operator typo / wrong key
    activate(ctx.env, 'v2')
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v1': 3 })
    expect((await ctx.env.DB.prepare('SELECT count(*) AS n FROM key_rotations').first<{ n: number }>())!.n).toBe(0)
    const active = await ctx.env.DB.prepare("SELECT version FROM encryption_keys WHERE status = 'active'").first<{ version: string }>()
    expect(active!.version).toBe('v1')
  })

  it('refuses to activate a version whose key is not deployed', async () => {
    const ctx = await setup({ v2: false })
    await seedMany(ctx, 2)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_VERSION_UNAVAILABLE' })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v1': 2 })
  })

  it('holds the job (does not fail it) when a key disappears mid-rotation, and resumes when it returns', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 30)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never, { batchSize: 10 }) // activation
    await rotationTick(ctx.env as never, { batchSize: 10 }) // one batch
    const before = await versionCounts(ctx)
    const v2Key = ctx.env['ENCRYPTION_KEY_V2'] as string
    delete ctx.env['ENCRYPTION_KEY_V2']
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_VERSION_UNAVAILABLE' })
    expect(await versionCounts(ctx)).toEqual(before) // nothing written while the key is missing
    const held = await ctx.env.DB.prepare('SELECT status, last_error_code FROM key_rotations').first<{ status: string; last_error_code: string }>()
    expect(held).toEqual({ status: 'running', last_error_code: 'KEY_VERSION_UNAVAILABLE' })

    ctx.env['ENCRYPTION_KEY_V2'] = v2Key // operator fixes the deployment
    const results = await runToEnd(ctx.env, { batchSize: 10 })
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 0 })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v2': 30 })
    await assertAllDecryptable(ctx, expected)
  })

  it('quarantines a row labelled with an unknown key version instead of stopping', async () => {
    const ctx = await setup()
    await seedMany(ctx, 4)
    await ctx.env.DB.prepare("UPDATE secrets SET key_version = 'v7' WHERE name = 'S_1'").run()
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    const results = await runToEnd(ctx.env)
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 1 })
    const f = await ctx.env.DB.prepare('SELECT error_code FROM key_rotation_failures').all()
    expect(f.results).toEqual([{ error_code: 'KEY_VERSION_UNAVAILABLE' }])
  })

  it('first tick on a populated database with ACTIVE=v2 registers v1 and still rotates', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 12)
    activate(ctx.env, 'v2') // migration 0006 and the cron deploy go out together with ACTIVE=v2
    const results = await runToEnd(ctx.env, { batchSize: 5 })
    expect(results[0]).toEqual({ state: 'bootstrapped', version: 'v1' })
    expect(results[1]).toMatchObject({ state: 'activated', from: 'v1', to: 'v2' })
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 0 })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v2': 12 })
    await assertAllDecryptable(ctx, expected)
  })

  it('refuses to bootstrap when the deployed key cannot unwrap existing data', async () => {
    const ctx = await setup()
    await seedMany(ctx, 3)
    ctx.env.ENCRYPTION_MASTER_KEY = b64() // wrong key on the very first tick
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
    const n = await ctx.env.DB.prepare('SELECT count(*) AS n FROM encryption_keys').first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  // Issue #87. bootstrap() runs on every tick while encryption_keys has no 'active' row, and
  // used to write nothing when it failed — so a deployment with the wrong key repeated three
  // full table scans 1,440 times a day, forever.
  describe('bootstrap backoff', () => {
    /** Record which tables each statement touched. */
    function watchReads(env: TestEnv) {
      const real = env.DB
      const sql: string[] = []
      env.DB = {
        prepare: (q: string) => { sql.push(q); return real.prepare(q) },
        batch: real.batch.bind(real),
      } as unknown as TestEnv['DB']
      return { sql, restore: () => { env.DB = real } }
    }
    const scans = (sql: string[]) => sql.filter((q) => /FROM secrets|FROM integration_connections/.test(q))

    it('records the failure and skips the scans entirely on the next tick', async () => {
      const ctx = await setup()
      await seedMany(ctx, 3)
      ctx.env.ENCRYPTION_MASTER_KEY = b64()

      const first = watchReads(ctx.env)
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
      expect(scans(first.sql).length).toBeGreaterThan(0) // the attempt did happen
      first.restore()

      const stored = await ctx.env.DB.prepare('SELECT value FROM system_state WHERE key = ?')
        .bind('key_rotation.bootstrap_failed_at').first<{ value: string }>()
      expect(JSON.parse(stored!.value)).toEqual({ activeVersion: 'v1', code: 'KEY_CHECK_FAILED' })

      const second = watchReads(ctx.env)
      const result = await rotationTick(ctx.env as never)
      expect(result).toMatchObject({ state: 'bootstrap_backoff', code: 'KEY_CHECK_FAILED' })
      expect(scans(second.sql)).toEqual([]) // nothing scanned while backing off
      second.restore()
    })

    it('still writes nothing to encryption_keys or key_rotations while backing off', async () => {
      const ctx = await setup()
      await seedMany(ctx, 2)
      ctx.env.ENCRYPTION_MASTER_KEY = b64()
      for (let i = 0; i < 5; i += 1) await rotationTick(ctx.env as never)
      for (const table of ['encryption_keys', 'key_rotations']) {
        const n = await ctx.env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()
        expect(n!.n).toBe(0)
      }
    })

    it('backs off exactly BOOTSTRAP_RETRY_MS, then retries', async () => {
      const ctx = await setup()
      await seedMany(ctx, 3)
      const good = ctx.env.ENCRYPTION_MASTER_KEY
      ctx.env.ENCRYPTION_MASTER_KEY = b64()
      const t0 = new Date('2026-10-05T00:00:00.000Z')
      expect(await rotationTick(ctx.env as never, { now: t0 })).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })

      // One millisecond short: still suppressed, and the remaining wait is reported.
      const nearly = new Date(t0.getTime() + BOOTSTRAP_RETRY_MS - 1)
      expect(await rotationTick(ctx.env as never, { now: nearly }))
        .toEqual({ state: 'bootstrap_backoff', code: 'KEY_CHECK_FAILED', retryAfterMs: 1 })

      // Due, and still broken: it attempts again and records the fresh attempt.
      const due = new Date(t0.getTime() + BOOTSTRAP_RETRY_MS)
      expect(await rotationTick(ctx.env as never, { now: due })).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
      const again = await ctx.env.DB.prepare('SELECT updated_at FROM system_state WHERE key = ?')
        .bind('key_rotation.bootstrap_failed_at').first<{ updated_at: string }>()
      expect(again!.updated_at).toBe(due.toISOString())

      // Fixed: the next due tick recovers on its own and clears the record.
      ctx.env.ENCRYPTION_MASTER_KEY = good
      const later = new Date(due.getTime() + BOOTSTRAP_RETRY_MS)
      expect(await rotationTick(ctx.env as never, { now: later })).toEqual({ state: 'bootstrapped', version: 'v1' })
      expect(await ctx.env.DB.prepare('SELECT value FROM system_state WHERE key = ?')
        .bind('key_rotation.bootstrap_failed_at').first()).toBeNull()
      expect(await rotationTick(ctx.env as never, { now: later })).toEqual({ state: 'idle' })
    })

    it('retries at once when the deployment names a different active version', async () => {
      const ctx = await setup()
      await seedMany(ctx, 3)
      const good = ctx.env.ENCRYPTION_MASTER_KEY
      ctx.env.ENCRYPTION_MASTER_KEY = b64()
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })

      // The operator redeploys with a different ENCRYPTION_ACTIVE_KEY_VERSION. The stored
      // failure was about a different question, so it must not suppress this attempt — even
      // though the interval has not elapsed and the key is still wrong.
      activate(ctx.env, 'v2')
      const retry = watchReads(ctx.env)
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
      expect(scans(retry.sql).length).toBeGreaterThan(0)
      retry.restore()

      // And once the key is restored it bootstraps on the next tick, with no wait.
      ctx.env.ENCRYPTION_MASTER_KEY = good
      activate(ctx.env, 'v1')
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'bootstrapped', version: 'v1' })
    })

    it('attempts rather than backs off when the stored record is unreadable', async () => {
      const ctx = await setup()
      await seedMany(ctx, 2)
      await ctx.env.DB.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)')
        .bind('key_rotation.bootstrap_failed_at', 'not json', new Date().toISOString()).run()
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'bootstrapped', version: 'v1' })
    })

    it('records nothing when the first attempt succeeds', async () => {
      const ctx = await setup()
      await seedMany(ctx, 2)
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'bootstrapped', version: 'v1' })
      expect(await ctx.env.DB.prepare('SELECT count(*) AS n FROM system_state').first<{ n: number }>()).toEqual({ n: 0 })
    })

    it('keeps working when migration 0016 has not been applied', async () => {
      const ctx = await setup()
      await seedMany(ctx, 2)
      ctx.env.DB.sqlite.exec('DROP TABLE system_state')
      ctx.env.ENCRYPTION_MASTER_KEY = b64()
      // No backoff is possible without the table, but the tick must not break.
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
      expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
    })

    it('never logs key material while backing off', async () => {
      const ctx = await setup()
      await seedMany(ctx, 2)
      const wrong = b64()
      ctx.env.ENCRYPTION_MASTER_KEY = wrong
      await rotationTick(ctx.env as never)
      await rotationTick(ctx.env as never)
      const haystack = logs.join('\n')
      expect(haystack).toContain('key_rotation.bootstrap_failed')
      for (const needle of [wrong, String(ctx.env['ENCRYPTION_KEY_V2'])]) {
        expect(haystack).not.toContain(needle)
      }
    })
  })

  it('quarantines a corrupt row, finishes the rest, and reports completed_with_errors', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 10)
    const bad = await ctx.env.DB.prepare("SELECT id FROM secrets WHERE name = 'S_3'").first<{ id: string }>()
    await ctx.env.DB.prepare("UPDATE secrets SET wrapped_dek = 'corrupted' WHERE id = ?").bind(bad!.id).run()
    expected.delete(`secret:${bad!.id}`)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    const results = await runToEnd(ctx.env)
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 1 })
    const job = await ctx.env.DB.prepare('SELECT status FROM key_rotations').first<{ status: string }>()
    expect(job!.status).toBe('completed_with_errors')
    const failures = await ctx.env.DB.prepare('SELECT table_name, row_id, error_code FROM key_rotation_failures').all()
    expect(failures.results).toEqual([{ table_name: 'secrets', row_id: bad!.id, error_code: 'UNWRAP_FAILED' }])
    const counts = await versionCounts(ctx)
    expect(counts['secrets:v2']).toBe(9)
    expect(counts['secrets:v1']).toBe(1)
  })

  it('pauses when the active version changes mid-job and a reverse rotation round-trips', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 30)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never, { batchSize: 10 }) // activate
    await rotationTick(ctx.env as never, { batchSize: 10 }) // partial progress
    activate(ctx.env, 'v1') // operator rolls back
    const r = await rotationTick(ctx.env as never, { batchSize: 10 })
    expect(r).toMatchObject({ state: 'activated', from: 'v2', to: 'v1' })
    const results = await runToEnd(ctx.env, { batchSize: 10 })
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 0 })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v1': 30 })
    await assertAllDecryptable(ctx, expected)
    const statuses = await ctx.env.DB.prepare('SELECT status, count(*) AS n FROM key_rotations GROUP BY status ORDER BY status').all()
    expect(statuses.results).toEqual([{ status: 'completed', n: 1 }, { status: 'paused', n: 1 }])
  })

  // Issue #84: the `history` phase is gone. A rotation could be stored mid-flight on it when
  // that deploys, and the engine must neither wedge nor skip a table. Migration 0017 rewrites
  // the stored value, so this covers the belt rather than the braces: the phase as the code
  // finds it before (or without) the migration.
  it('finishes a job left mid-flight on the removed history phase', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 6)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never, { batchSize: 100 }) // activate
    await rotationTick(ctx.env as never, { batchSize: 100 }) // secrets phase runs to the end

    // Exactly the state 0017 can land on: the secrets phase done, the cursor at its end, and the
    // job parked on a phase this build does not have. (The CHECK still permits the value.)
    await ctx.env.DB.prepare("UPDATE key_rotations SET phase = 'history' WHERE status = 'running'").run()

    const results = await runToEnd(ctx.env, { batchSize: 100, maxTicks: 10 })
    expect(results.at(-1)).toEqual({ state: 'completed', failed: 0 })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v2': 6 })
    await assertAllDecryptable(ctx, expected)
    const job = await ctx.env.DB.prepare('SELECT status, phase FROM key_rotations').first<{ status: string; phase: string }>()
    expect(job).toEqual({ status: 'completed', phase: 'connections' })
  })

  it('does not run twice concurrently (lease)', async () => {
    const ctx = await setup()
    await seedMany(ctx, 5)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never) // activation
    await ctx.env.DB.prepare("UPDATE key_rotations SET lease_until = '2999-01-01T00:00:00.000Z', lease_owner = 'someone-else'").run()
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'busy' })
    expect(await versionCounts(ctx)).toEqual({ 'secrets:v1': 5 })
  })

  it('reports an error instead of throwing when migration 0006 has not been applied', async () => {
    const ctx = await setup()
    ctx.env.DB.sqlite.exec('DROP TABLE key_rotations; DROP TABLE encryption_keys; DROP TABLE key_rotation_failures')
    expect(await rotationTick(ctx.env as never)).toEqual({ state: 'error', code: 'TICK_FAILED' })
  })

  it('never logs key material, DEKs, wrapped DEKs or values', async () => {
    const ctx = await setup()
    const expected = await seedMany(ctx, 5)
    await rotationTick(ctx.env as never)
    activate(ctx.env, 'v2')
    await runToEnd(ctx.env)
    const wrapped = (await ctx.env.DB.prepare('SELECT wrapped_dek FROM secrets').all<{ wrapped_dek: string }>()).results.map((r) => r.wrapped_dek)
    const haystack = logs.join('\n')
    for (const needle of [ctx.env.ENCRYPTION_MASTER_KEY, String(ctx.env['ENCRYPTION_KEY_V2']), ...wrapped, ...expected.values()]) {
      expect(haystack).not.toContain(needle)
    }
  })

  it('re-wraps integration credentials too, so the old key can be retired without losing them', async () => {
    const ctx = await setup()
    await seedMany(ctx, 2)
    const now = new Date().toISOString()
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const id = createPrefixedId('icn')
      ids.push(id)
      const sealed = await encryptCredentialWithRing(`cred-${i}-secret`, ringOf(ctx.env, 'v1'), { orgId: ctx.orgId, connectionId: id })
      await ctx.env.DB.prepare(
        'INSERT INTO integration_connections (id, org_id, provider, label, encrypted_credential, wrapped_dek, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, ctx.orgId, 'cloudflare-workers', `c${i}`, sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, now, now).run()
    }
    await rotationTick(ctx.env as never) // bootstrap v1
    activate(ctx.env, 'v2')
    await rotationTick(ctx.env as never) // activate
    const results = await runToEnd(ctx.env)
    expect(results[results.length - 1]).toMatchObject({ state: 'completed', failed: 0 })

    const rows = await ctx.env.DB.prepare('SELECT key_version FROM integration_connections').all<{ key_version: string }>()
    expect(rows.results.every((r) => r.key_version === 'v2')).toBe(true)
    // Decrypts with ONLY the v2 key present (v1 retired).
    const onlyV2 = { ...(ctx.env as object), ENCRYPTION_MASTER_KEY: '' } as never
    expect(await readCredential(onlyV2, ctx.orgId, ids[1] as string)).toBe('cred-1-secret')
  })
})
