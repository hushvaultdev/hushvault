// Automatic sync triggers (issue #42): on-change outbox, scheduled reconcile and retries of failed runs.
// Driven by the minute cron (`syncTick`). Everything is best-effort and value-free: the outbox holds ids only,
// the runs go through runSync (single flight, ledger, audit) exactly like a manual run, and failures surface as
// failed runs and `needs_attention` targets rather than exceptions.
import type { SyncTrigger } from '@hushvault/shared/integrations'
import type { Env } from '../index'
import { MAX_SYNC_ATTEMPTS, loadSyncTarget, runSync } from './sync-engine'

/** Changes inside this window coalesce into one run. The cron sweeps every minute, so latency is about 30-90 s. */
export const SYNC_DEBOUNCE_MS = 30_000
/** A claim older than this is considered abandoned (the Worker died) and the row is picked up again. */
export const OUTBOX_CLAIM_MS = 5 * 60_000
/** Automatic runs (change, schedule, retry) per organisation per hour; beyond it work is deferred, not dropped. */
export const MAX_AUTO_RUNS_PER_ORG_PER_HOUR = 60
export const DEFER_MS = 10 * 60_000
/** Backoff for a row whose run could not start (busy target, unavailable provider) so it cannot hog the window. */
export const RELEASE_BACKOFF_MS = 60_000
/**
 * Runs started per tick across all steps. Each run makes many D1/KV/provider subrequests and a Worker invocation has
 * a subrequest limit, so a sweep is deliberately small; the backlog drains over the next minutes.
 */
export const MAX_RUNS_PER_TICK = 5
const SELECT_LIMIT = 25
const OUTBOX_RETENTION_MS = 24 * 3_600_000

export type SyncTickResult = { changeRuns: number; scheduleRuns: number; retryRuns: number; deferred: number; failures: number }

type Budget = { left: number }

const plus = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString()

/**
 * Queue a sync for every on-change target whose environment is `envId` or inherits from it. One pending row per
 * target: while it waits, further changes only bump `changed_at` (upsert on the partial unique index), and a change
 * that lands while a run is in flight keeps the row pending so it is run again. Returns the number of rows touched.
 * Never throws: a failure only means the next reconcile catches up.
 */
export async function enqueueSyncForEnvironment(env: Env, envId: string, now: Date = new Date()): Promise<number> {
  try {
    const nowIso = now.toISOString()
    const result = await env.DB.prepare(
      `INSERT INTO sync_outbox (id, target_id, org_id, created_at, changed_at, due_at)
       SELECT 'iso_' || lower(hex(randomblob(10))), t.id, t.org_id, ?1, ?1, ?2
       FROM sync_targets t
       WHERE t.deleted_at IS NULL AND t.sync_on_change = 1 AND t.status = 'active'
         AND t.env_id IN (
           WITH RECURSIVE descendants(id) AS (
             SELECT ?3 UNION SELECT e.id FROM environments e JOIN descendants d ON e.parent_env_id = d.id
           ) SELECT id FROM descendants
         )
       ON CONFLICT (target_id) WHERE done_at IS NULL DO UPDATE SET changed_at = excluded.changed_at`,
    ).bind(nowIso, plus(now, SYNC_DEBOUNCE_MS), envId).run()
    return Number(result.meta.changes ?? 0)
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'sync.enqueue_failed' }))
    return 0
  }
}

/** Queue one target (used when an edit re-activates a target that missed changes while it needed attention). */
export async function enqueueSyncForTarget(env: Env, targetId: string, now: Date = new Date()): Promise<void> {
  try {
    const nowIso = now.toISOString()
    await env.DB.prepare(
      `INSERT INTO sync_outbox (id, target_id, org_id, created_at, changed_at, due_at)
       SELECT 'iso_' || lower(hex(randomblob(10))), t.id, t.org_id, ?1, ?1, ?2 FROM sync_targets t
       WHERE t.id = ?3 AND t.deleted_at IS NULL AND t.sync_on_change = 1 AND t.status = 'active'
       ON CONFLICT (target_id) WHERE done_at IS NULL DO UPDATE SET changed_at = excluded.changed_at`,
    ).bind(nowIso, plus(now, SYNC_DEBOUNCE_MS), targetId).run()
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'sync.enqueue_failed' }))
  }
}

async function autoRunsLastHour(env: Env, orgId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 3_600_000).toISOString()
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sync_runs r JOIN sync_targets t ON t.id = r.target_id WHERE t.org_id = ? AND r.trigger <> 'manual' AND r.started_at >= ?",
  ).bind(orgId, since).first<{ n: number }>()
  return row?.n ?? 0
}

/** A queued/running run with an unexpired lease. runSync would return it instead of starting a new one. */
async function hasActiveRun(env: Env, targetId: string, now: Date): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS active FROM sync_runs WHERE target_id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until >= ?) LIMIT 1",
  ).bind(targetId, now.toISOString()).first()
  return Boolean(row)
}

/**
 * Run and report whether THIS call started a fresh run. runSync returns an in-flight run instead of starting one
 * when it loses the single-flight race; that run may have planned before the change that queued us, so it does not
 * count ('busy'). A thrown SyncEngineError (target vanished, provider module missing) is 'failed'.
 */
async function safeRun(env: Env, targetId: string, trigger: Exclude<SyncTrigger, 'manual'>, attempt: number, now: Date): Promise<'ran' | 'busy' | 'failed'> {
  try {
    const run = await runSync(env, targetId, { trigger, attempt, now })
    return run.startedAt === now.toISOString() && run.trigger === trigger && run.attempt === attempt ? 'ran' : 'busy'
  } catch {
    return 'failed'
  }
}

/** Process due on-change rows: claim, run, complete only if no change landed meanwhile. */
async function drainOutbox(env: Env, now: Date, tally: SyncTickResult, budget: Budget): Promise<void> {
  const nowIso = now.toISOString()
  const staleIso = new Date(now.getTime() - OUTBOX_CLAIM_MS).toISOString()
  // Oldest due first; rows pushed back with a backoff sort behind rows that have never been tried.
  const due = await env.DB.prepare(
    'SELECT id, target_id, org_id FROM sync_outbox WHERE done_at IS NULL AND due_at <= ? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY due_at LIMIT ?',
  ).bind(nowIso, staleIso, SELECT_LIMIT).all<{ id: string; target_id: string; org_id: string }>()

  for (const row of due.results ?? []) {
    if (budget.left <= 0) return
    // Conditional claim: only one sweep wins a row.
    const claim = await env.DB.prepare('UPDATE sync_outbox SET claimed_at = ? WHERE id = ? AND done_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)')
      .bind(nowIso, row.id, staleIso).run()
    if (Number(claim.meta.changes ?? 0) !== 1) continue

    const release = (backoffMs: number) => env.DB.prepare('UPDATE sync_outbox SET claimed_at = NULL, due_at = ? WHERE id = ?').bind(plus(now, backoffMs), row.id).run()

    const target = await loadSyncTarget(env, row.target_id)
    if (!target || !target.autoSync.onChange || target.status !== 'active') {
      await env.DB.prepare('UPDATE sync_outbox SET done_at = ? WHERE id = ?').bind(nowIso, row.id).run()
      continue
    }
    if ((await autoRunsLastHour(env, row.org_id, now)) >= MAX_AUTO_RUNS_PER_ORG_PER_HOUR) {
      await release(DEFER_MS)
      tally.deferred += 1
      continue
    }
    // A run already in flight may have started before this change: keep the row so a later sweep syncs it.
    if (await hasActiveRun(env, row.target_id, now)) {
      await release(RELEASE_BACKOFF_MS)
      continue
    }
    budget.left -= 1
    const outcome = await safeRun(env, row.target_id, 'change', 1, now)
    if (outcome === 'ran') {
      // Complete the row only if nothing changed after we claimed it; otherwise run again after the debounce.
      const done = await env.DB.prepare('UPDATE sync_outbox SET done_at = ? WHERE id = ? AND changed_at <= claimed_at')
        .bind(new Date().toISOString(), row.id).run()
      if (Number(done.meta.changes ?? 0) !== 1) await release(SYNC_DEBOUNCE_MS)
      tally.changeRuns += 1
    } else {
      await release(outcome === 'busy' ? RELEASE_BACKOFF_MS : 5 * RELEASE_BACKOFF_MS)
      tally.failures += outcome === 'failed' ? 1 : 0
    }
  }
}

/** Targets with a schedule whose last run is older than the interval (and have no active run). */
async function runSchedules(env: Env, now: Date, tally: SyncTickResult, budget: Budget): Promise<void> {
  // An expired lease does not count as active: runSync closes it, which is the only way a crashed run is recovered.
  const rows = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.schedule_minutes, t.last_run_at FROM sync_targets t
     WHERE t.deleted_at IS NULL AND t.status = 'active' AND t.schedule_minutes IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.target_id = t.id AND r.status IN ('queued', 'running') AND (r.lease_until IS NULL OR r.lease_until >= ?))
     ORDER BY COALESCE(t.last_run_at, '') LIMIT ?`,
  ).bind(now.toISOString(), SELECT_LIMIT * 4).all<{ id: string; org_id: string; schedule_minutes: number; last_run_at: string | null }>()
  for (const row of rows.results ?? []) {
    if (budget.left <= 0) return
    const lastMs = row.last_run_at ? Date.parse(row.last_run_at) : 0
    if (now.getTime() - lastMs < row.schedule_minutes * 60_000) continue
    if ((await autoRunsLastHour(env, row.org_id, now)) >= MAX_AUTO_RUNS_PER_ORG_PER_HOUR) {
      tally.deferred += 1
      continue
    }
    budget.left -= 1
    const outcome = await safeRun(env, row.id, 'schedule', 1, now)
    if (outcome === 'ran') tally.scheduleRuns += 1
    else if (outcome === 'failed') tally.failures += 1
  }
}

/**
 * Retry runs whose `next_retry_at` has come: only the target's newest run counts (a later success or manual run
 * supersedes an old failure), and only while attempts remain and the target is still active. The marker is NOT
 * cleared up front: runSync clears it once it has inserted its own run, so a run that never starts is retried again.
 */
async function retryFailed(env: Env, now: Date, tally: SyncTickResult, budget: Budget): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.target_id, r.attempt, t.org_id FROM sync_runs r JOIN sync_targets t ON t.id = r.target_id
     WHERE r.next_retry_at IS NOT NULL AND r.next_retry_at <= ? AND r.status IN ('failed', 'partial')
       AND t.deleted_at IS NULL AND t.status = 'active'
       AND r.id = (SELECT r2.id FROM sync_runs r2 WHERE r2.target_id = r.target_id ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1)
     ORDER BY r.next_retry_at LIMIT ?`,
  ).bind(now.toISOString(), SELECT_LIMIT).all<{ id: string; target_id: string; attempt: number; org_id: string }>()
  for (const row of rows.results ?? []) {
    if (budget.left <= 0) return
    if (row.attempt >= MAX_SYNC_ATTEMPTS) {
      await env.DB.prepare('UPDATE sync_runs SET next_retry_at = NULL WHERE id = ?').bind(row.id).run()
      continue
    }
    if ((await autoRunsLastHour(env, row.org_id, now)) >= MAX_AUTO_RUNS_PER_ORG_PER_HOUR) {
      tally.deferred += 1
      continue
    }
    if (await hasActiveRun(env, row.target_id, now)) continue // retried on a later sweep
    budget.left -= 1
    const outcome = await safeRun(env, row.target_id, 'change', row.attempt + 1, now)
    if (outcome === 'ran') tally.retryRuns += 1
    else if (outcome === 'failed') tally.failures += 1
  }
}

/** One sweep. Called from the minute cron; safe to call concurrently (claims and single flight). */
export async function syncTick(env: Env, now: Date = new Date()): Promise<SyncTickResult> {
  const tally: SyncTickResult = { changeRuns: 0, scheduleRuns: 0, retryRuns: 0, deferred: 0, failures: 0 }
  const budget: Budget = { left: MAX_RUNS_PER_TICK }
  for (const step of [drainOutbox, retryFailed, runSchedules]) {
    try {
      await step(env, now, tally, budget)
    } catch {
      tally.failures += 1
      console.error(JSON.stringify({ level: 'error', event: 'sync.tick_step_failed', step: step.name }))
    }
  }
  try {
    await env.DB.prepare('DELETE FROM sync_outbox WHERE done_at IS NOT NULL AND done_at < ?').bind(new Date(now.getTime() - OUTBOX_RETENTION_MS).toISOString()).run()
  } catch {
    // housekeeping only
  }
  // Deferred work is expected steady state for a capped organisation: not worth a log line every minute.
  if (tally.changeRuns + tally.scheduleRuns + tally.retryRuns + tally.failures > 0) {
    console.error(JSON.stringify({ level: 'info', event: 'sync.tick', ...tally }))
  }
  return tally
}
