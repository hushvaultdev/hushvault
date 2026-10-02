// Master-key (KEK) rotation: re-wrap data-encryption keys (DEKs) from one key
// version to another, driven by a Cron Trigger. Issue #27, docs/ENCRYPTION.md.
//
// Invariants (see test/key-rotation.test.ts):
//  - Only wrapped DEKs in D1 are rewritten; KV ciphertext and plaintext are never touched.
//  - Every row stays decryptable at every instant: a row is either under its old
//    version or its new one, and both keys stay in the ring until an operator retires one.
//  - Per-row writes are compare-and-swap, so a concurrent PATCH (new DEK) or a second
//    worker simply makes the row a no-op.
//  - The cursor and counters are written in the same D1 batch as the rows they cover.
//  - No key, DEK, wrapped DEK, ciphertext or plaintext is ever logged or stored here.
import type { Env } from '../index'
import {
  KeyRingError,
  canUnwrapDek,
  loadKeyRing,
  makeKeyCheck,
  rewrapDek,
  verifyKeyCheck,
  type KeyRing,
} from '../crypto/envelope'

export const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 500
const WRITE_CHUNK = 50
const LEASE_MS = 90_000

type Table = 'secrets' | 'secret_history'

type RotationRow = {
  id: string
  from_version: string
  to_version: string
  status: string
  phase: 'secrets' | 'history'
  secrets_cursor: string | null
  history_cursor: string | null
  rewrapped: number
  skipped: number
  failed: number
  last_error_code: string | null
}

export type TickResult =
  | { state: 'idle' }
  | { state: 'unconfigured' }
  | { state: 'bootstrapped'; version: string }
  | { state: 'activated'; from: string; to: string }
  | { state: 'progress'; rewrapped: number; skipped: number; failed: number }
  | { state: 'completed'; failed: number }
  | { state: 'paused' }
  | { state: 'failed'; code: string }
  | { state: 'busy' }
  | { state: 'error'; code: string }

export type TickOptions = {
  now?: Date
  batchSize?: number
  owner?: string
}

function batchSizeFrom(env: Env, override?: number): number {
  const raw = override ?? Number.parseInt(String((env as unknown as Record<string, unknown>)['ROTATION_BATCH_SIZE'] ?? ''), 10)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE
  return Math.min(Math.floor(raw), MAX_BATCH_SIZE)
}

function logEvent(event: string, fields: Record<string, string | number | null> = {}): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }))
}

/** Deployment-wide event fanned out to every organisation's audit log (actor: system). */
async function auditAllOrgs(env: Env, action: string, version: string, nowIso: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, timestamp) SELECT 'audit_' || lower(hex(randomblob(16))), id, NULL, 'system', ?, 'encryption_key', ?, NULL, NULL, ? FROM organisations",
  ).bind(action, version, nowIso).run()
}

function newId(): string {
  return `rot_${crypto.randomUUID().replace(/-/g, '')}`
}

/**
 * The ring used for WRITES (POST/PATCH). New DEKs are wrapped with the version that the
 * rotation tick has registered and verified as active in D1, NOT with the raw
 * ENCRYPTION_ACTIVE_KEY_VERSION variable: a mistyped new key is therefore never used for
 * writes before the tick has validated it. Before the first tick (or before migration 0006)
 * the legacy version v1 is used.
 */
export async function loadWriteRing(env: Env): Promise<KeyRing> {
  let version = 'v1'
  try {
    const row = await env.DB.prepare("SELECT version FROM encryption_keys WHERE status = 'active' LIMIT 1").first<{ version: string }>()
    if (row) version = row.version
  } catch {
    // table missing: migration 0006 not applied yet
  }
  return loadKeyRing(env, { activeVersion: version })
}

/**
 * One scheduled tick. Steady state (nothing to do) issues exactly two single-row reads.
 * Safe to call concurrently: a lease makes at most one tick drive a rotation at a time.
 */
export async function rotationTick(env: Env, options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()

  let ring: KeyRing
  try {
    ring = loadKeyRing(env)
  } catch (err) {
    return { state: 'error', code: err instanceof KeyRingError ? err.code : 'KEY_INVALID' }
  }

  try {
    const active = await env.DB.prepare("SELECT version, check_value FROM encryption_keys WHERE status = 'active' LIMIT 1")
      .first<{ version: string; check_value: string }>()
    const running = await env.DB.prepare("SELECT * FROM key_rotations WHERE status = 'running' LIMIT 1").first<RotationRow>()

    if (!active) return await bootstrap(env, ring, nowIso)

    if (active.version !== ring.activeVersion) {
      if (running) await pauseRunning(env, running, nowIso)
      return await activate(env, ring, active.version, nowIso)
    }

    if (!running) return { state: 'idle' }

    if (running.to_version !== ring.activeVersion) {
      await pauseRunning(env, running, nowIso)
      return { state: 'paused' }
    }
    return await drive(env, ring, running, nowIso, options)
  } catch (err) {
    if (err instanceof KeyRingError) return { state: 'error', code: err.code }
    // Most likely migration 0006 has not been applied yet. Opaque on purpose.
    console.error(JSON.stringify({ level: 'error', event: 'key_rotation.tick_failed', errorName: err instanceof Error ? err.name : 'UnknownError' }))
    return { state: 'error', code: 'TICK_FAILED' }
  }
}

/**
 * First tick on a deployment: register the key the existing data uses (verified against a real
 * wrapped DEK) as active. If the deployment already names a different active version, the next
 * tick then starts a rotation, so a first deploy with ACTIVE != v1 on a populated database is
 * not silently skipped.
 */
async function bootstrap(env: Env, ring: KeyRing, nowIso: string): Promise<TickResult> {
  const used = await env.DB.prepare('SELECT key_version AS v FROM secrets UNION SELECT key_version FROM secret_history').all<{ v: string }>()
  const versions = (used.results ?? []).map((r) => r.v)
  const others = versions.filter((v) => v !== ring.activeVersion).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))
  const version = others[0] ?? ring.activeVersion

  const key = await ring.getKey(version)
  // Refuse to enshrine a key that cannot unwrap the data it is supposed to protect.
  for (const table of ['secrets', 'secret_history'] as const) {
    const sample = await env.DB.prepare(`SELECT wrapped_dek FROM ${table} WHERE key_version = ? LIMIT 1`).bind(version).first<{ wrapped_dek: string }>()
    if (sample && !(await canUnwrapDek(sample.wrapped_dek, key))) {
      console.error(JSON.stringify({ level: 'error', event: 'key_rotation.key_check_failed', keyVersion: version }))
      return { state: 'error', code: 'KEY_CHECK_FAILED' }
    }
  }

  const existing = await env.DB.prepare('SELECT check_value FROM encryption_keys WHERE version = ? LIMIT 1').bind(version).first<{ check_value: string }>()
  if (existing && !(await verifyKeyCheck(key, existing.check_value))) {
    console.error(JSON.stringify({ level: 'error', event: 'key_rotation.key_check_failed', keyVersion: version }))
    return { state: 'error', code: 'KEY_CHECK_FAILED' }
  }
  if (existing) {
    await env.DB.prepare("UPDATE encryption_keys SET status = 'active', activated_at = COALESCE(activated_at, ?) WHERE version = ?").bind(nowIso, version).run()
  } else {
    await env.DB.prepare("INSERT INTO encryption_keys (version, check_value, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)")
      .bind(version, await makeKeyCheck(key), nowIso, nowIso).run()
    await auditAllOrgs(env, 'key.version.registered', version, nowIso)
  }
  logEvent('key_rotation.bootstrapped', { keyVersion: version })
  return { state: 'bootstrapped', version }
}

/** The deployment now names a different active version: validate it, then start a rotation. */
async function activate(env: Env, ring: KeyRing, fromVersion: string, nowIso: string): Promise<TickResult> {
  const toVersion = ring.activeVersion
  // Fail closed: both keys must be present, and any registered check value must still verify.
  let fromKey: CryptoKey
  let toKey: CryptoKey
  try {
    fromKey = await ring.getKey(fromVersion)
    toKey = await ring.getKey(toVersion)
  } catch (err) {
    return failActivation(err instanceof KeyRingError ? err.code : 'KEY_INVALID', toVersion)
  }
  const oldCheck = await env.DB.prepare('SELECT check_value FROM encryption_keys WHERE version = ? LIMIT 1').bind(fromVersion).first<{ check_value: string }>()
  if (oldCheck && !(await verifyKeyCheck(fromKey, oldCheck.check_value))) {
    return failActivation('KEY_CHECK_FAILED', fromVersion)
  }
  const newCheck = await env.DB.prepare('SELECT check_value FROM encryption_keys WHERE version = ? LIMIT 1').bind(toVersion).first<{ check_value: string }>()
  if (newCheck && !(await verifyKeyCheck(toKey, newCheck.check_value))) {
    return failActivation('KEY_CHECK_FAILED', toVersion)
  }

  const rotationId = newId()
  const activateNew = newCheck
    ? env.DB.prepare("UPDATE encryption_keys SET status = 'active', activated_at = ?, retired_at = NULL WHERE version = ?").bind(nowIso, toVersion)
    : env.DB.prepare("INSERT INTO encryption_keys (version, check_value, status, created_at, activated_at) VALUES (?, ?, 'active', ?, ?)")
      .bind(toVersion, await makeKeyCheck(toKey), nowIso, nowIso)
  const statements = [
    env.DB.prepare("UPDATE encryption_keys SET status = 'decrypt_only' WHERE version = ?").bind(fromVersion),
    activateNew,
    env.DB.prepare(
      "INSERT INTO key_rotations (id, from_version, to_version, status, phase, started_at, updated_at) VALUES (?, ?, ?, 'running', 'secrets', ?, ?)",
    ).bind(rotationId, fromVersion, toVersion, nowIso, nowIso),
  ]
  await env.DB.batch(statements)
  await auditAllOrgs(env, 'key.rotation.started', toVersion, nowIso)
  logEvent('key_rotation.started', { from: fromVersion, to: toVersion })
  return { state: 'activated', from: fromVersion, to: toVersion }
}

function failActivation(code: string, version: string): TickResult {
  console.error(JSON.stringify({ level: 'error', event: 'key_rotation.activation_refused', code, keyVersion: version }))
  return { state: 'error', code }
}

async function pauseRunning(env: Env, running: RotationRow, nowIso: string): Promise<void> {
  await env.DB.prepare("UPDATE key_rotations SET status = 'paused', lease_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(nowIso, running.id).run()
  await auditAllOrgs(env, 'key.rotation.paused', running.to_version, nowIso)
  logEvent('key_rotation.paused', { from: running.from_version, to: running.to_version })
}

/**
 * A configuration problem (missing key) must not end the job: it stays `running`, records the
 * code, and is retried on the next tick once the operator fixes the deployment.
 */
async function holdOnError(env: Env, job: RotationRow, code: string, nowIso: string): Promise<TickResult> {
  await env.DB.prepare("UPDATE key_rotations SET last_error_code = ?, updated_at = ?, lease_until = NULL, lease_owner = NULL WHERE id = ? AND status = 'running'")
    .bind(code, nowIso, job.id).run()
  if (job.last_error_code !== code) {
    await auditAllOrgs(env, 'key.rotation.error', job.to_version, nowIso)
    console.error(JSON.stringify({ level: 'error', event: 'key_rotation.waiting_for_key', code, from: job.from_version, to: job.to_version }))
  }
  return { state: 'error', code }
}

async function drive(env: Env, ring: KeyRing, job: RotationRow, nowIso: string, options: TickOptions): Promise<TickResult> {
  // Lease: compare-and-swap so only one tick drives the job at a time. The status guard stops a
  // tick that read 'running' before the job was finished/paused from driving it afterwards.
  const owner = options.owner ?? crypto.randomUUID()
  const leaseUntil = new Date(Date.parse(nowIso) + LEASE_MS).toISOString()
  const lease = await env.DB.prepare(
    "UPDATE key_rotations SET lease_owner = ?, lease_until = ? WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)",
  ).bind(owner, leaseUntil, job.id, nowIso).run()
  if (Number(lease.meta.changes) !== 1) return { state: 'busy' }

  const release = () => env.DB.prepare('UPDATE key_rotations SET lease_until = NULL, lease_owner = NULL WHERE id = ? AND lease_owner = ?').bind(job.id, owner).run()

  try {
    // Both keys must be usable before any write. A missing key holds the job (it is retried).
    let toKey: CryptoKey
    try {
      toKey = await ring.getKey(job.to_version)
      await ring.getKey(job.from_version)
    } catch (err) {
      return await holdOnError(env, job, err instanceof KeyRingError ? err.code : 'KEY_INVALID', nowIso)
    }

    const table: Table = job.phase === 'secrets' ? 'secrets' : 'secret_history'
    const cursor = (job.phase === 'secrets' ? job.secrets_cursor : job.history_cursor) ?? ''
    const limit = batchSizeFrom(env, options.batchSize)

    const { results } = await env.DB.prepare(
      `SELECT id, wrapped_dek, key_version FROM ${table} WHERE id > ? AND key_version <> ? AND id NOT IN (SELECT row_id FROM key_rotation_failures WHERE rotation_id = ? AND table_name = ?) ORDER BY id LIMIT ?`,
    ).bind(cursor, job.to_version, job.id, table, limit).all<{ id: string; wrapped_dek: string; key_version: string }>()
    const rows = results ?? []

    let rewrapped = 0
    let skipped = 0
    let failed = 0
    for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
      const chunk = rows.slice(start, start + WRITE_CHUNK)
      const writes: ReturnType<D1Database['prepare']>[] = []
      const failures: ReturnType<D1Database['prepare']>[] = []
      for (const row of chunk) {
        const quarantine = (code: string) => {
          failed += 1
          failures.push(
            env.DB.prepare('INSERT OR IGNORE INTO key_rotation_failures (rotation_id, table_name, row_id, error_code) VALUES (?, ?, ?, ?)')
              .bind(job.id, table, row.id, code),
          )
        }
        // A row labelled with a version this deployment does not have cannot be re-wrapped; it is
        // quarantined (the job finishes completed_with_errors and the status endpoint shows it).
        if (!ring.has(row.key_version)) {
          quarantine('KEY_VERSION_UNAVAILABLE')
          continue
        }
        try {
          const fromKey = await ring.getKey(row.key_version)
          const next = await rewrapDek(row.wrapped_dek, fromKey, toKey)
          writes.push(
            env.DB.prepare(`UPDATE ${table} SET wrapped_dek = ?, key_version = ? WHERE id = ? AND wrapped_dek = ? AND key_version = ?`)
              .bind(next, job.to_version, row.id, row.wrapped_dek, row.key_version),
          )
        } catch {
          quarantine('UNWRAP_FAILED')
        }
      }
      const last = chunk[chunk.length - 1]
      const progress = env.DB.prepare(
        `UPDATE key_rotations SET ${job.phase === 'secrets' ? 'secrets_cursor' : 'history_cursor'} = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      ).bind(last?.id ?? cursor, nowIso, job.id)
      const batchResults = await env.DB.batch([...writes, ...failures, progress])
      for (let i = 0; i < writes.length; i += 1) {
        if (Number(batchResults[i]?.meta.changes ?? 0) === 1) rewrapped += 1
        else skipped += 1
      }
    }

    await env.DB.prepare("UPDATE key_rotations SET rewrapped = rewrapped + ?, skipped = skipped + ?, failed = failed + ?, last_error_code = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(rewrapped, skipped, failed, nowIso, job.id).run()

    if (rows.length === limit) {
      logEvent('key_rotation.progress', { rewrapped, skipped, failed })
      return { state: 'progress', rewrapped, skipped, failed }
    }

    // This phase is exhausted from the cursor onward.
    if (job.phase === 'secrets') {
      await env.DB.prepare("UPDATE key_rotations SET phase = 'history', history_cursor = NULL, updated_at = ? WHERE id = ? AND status = 'running'").bind(nowIso, job.id).run()
      return { state: 'progress', rewrapped, skipped, failed }
    }

    // History done. Convergence: rows written under the old version by a stale isolate (or restored
    // from a backup) behind the cursor start another pass instead of being missed.
    const remaining = await countRemaining(env, job)
    if (remaining > 0) {
      await env.DB.prepare("UPDATE key_rotations SET phase = 'secrets', secrets_cursor = NULL, history_cursor = NULL, updated_at = ? WHERE id = ? AND status = 'running'").bind(nowIso, job.id).run()
      return { state: 'progress', rewrapped, skipped, failed }
    }

    const final = await env.DB.prepare('SELECT failed FROM key_rotations WHERE id = ?').bind(job.id).first<{ failed: number }>()
    const failedTotal = final?.failed ?? 0
    const status = failedTotal > 0 ? 'completed_with_errors' : 'completed'
    const done = await env.DB.prepare("UPDATE key_rotations SET status = ?, completed_at = ?, updated_at = ?, lease_until = NULL, lease_owner = NULL WHERE id = ? AND status = 'running'")
      .bind(status, nowIso, nowIso, job.id).run()
    if (Number(done.meta.changes) === 1) {
      await auditAllOrgs(env, status === 'completed' ? 'key.rotation.completed' : 'key.rotation.completed_with_errors', job.to_version, nowIso)
      logEvent('key_rotation.finished', { status, failed: failedTotal })
    }
    return { state: 'completed', failed: failedTotal }
  } finally {
    await release().catch(() => undefined)
  }
}

async function countRemaining(env: Env, job: RotationRow): Promise<number> {
  let total = 0
  for (const table of ['secrets', 'secret_history'] as const) {
    const row = await env.DB.prepare(
      `SELECT count(*) AS n FROM ${table} WHERE key_version <> ? AND id NOT IN (SELECT row_id FROM key_rotation_failures WHERE rotation_id = ? AND table_name = ?)`,
    ).bind(job.to_version, job.id, table).first<{ n: number }>()
    total += row?.n ?? 0
  }
  return total
}
