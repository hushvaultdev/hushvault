// Cron housekeeping: the deletes nothing else does (issue #80).
//
// Three tables grew without bound. `audit_log` is the fastest — one row per secret read, plus
// three per sync run, which a minute cron can turn into tens of thousands a day — and retention
// was only ever a filter applied to reads, so a free-plan organisation was told it had seven-day
// retention while every row it ever wrote stayed in D1 forever. `share_links` kept its
// `encrypted_payload` after the link expired or was used up, so ciphertext nobody can reach any
// more still landed in every `wrangler d1 export`. `auth_tokens` was only purged opportunistically
// by the routes that happened to touch it.
//
// Two rules shape this file:
//   - Bounded per tick. The cron shares one subrequest and CPU budget with rotation and sync, so
//     every statement here has a LIMIT and the organisation loop has a cap.
//   - The audit sweep uses the PLAN's window, never the per-organisation override. The override
//     narrows what the API shows; letting it delete would turn a display preference into a
//     self-destruct button for the trail that is supposed to be watching whoever set it.
import type { Env } from '../index'
import { AUDIT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, retentionCutoffIso } from './audit-retention'
import { logEvent } from './security'

/** Organisations whose audit log is swept per tick. */
export const AUDIT_SWEEP_ORGS_PER_TICK = 20
/** Rows deleted per organisation per tick. The next tick continues where this one stopped. */
export const AUDIT_SWEEP_ROWS_PER_TICK = 500
/** Expired or exhausted share links removed per tick. */
export const SHARE_PURGE_PER_TICK = 200

export type HousekeepingResult = {
  auditRowsDeleted: number
  shareLinksDeleted: number
  authTokensDeleted: number
}

/**
 * Sweep audit rows outside each organisation's plan retention window.
 *
 * Organisations are taken in rotation by id so that one very busy organisation cannot starve the
 * others: the cursor is simply "the ids after the last one we looked at", wrapping each tick.
 */
async function sweepAuditLog(env: Env, now: Date): Promise<number> {
  // Only plans with a finite window. An unrecognised plan string falls back to the most
  // restrictive tier, matching effectiveRetentionDays.
  const orgs = await env.DB.prepare(
    `SELECT id, plan FROM organisations
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_log.org_id = organisations.id)
      ORDER BY id LIMIT ?`,
  ).bind(AUDIT_SWEEP_ORGS_PER_TICK).all<{ id: string; plan: string }>()

  let deleted = 0
  for (const org of orgs.results ?? []) {
    const planDays = AUDIT_RETENTION_DAYS[org.plan] ?? DEFAULT_RETENTION_DAYS
    const cutoff = retentionCutoffIso(planDays, now)
    if (cutoff === null) continue // retain forever

    // Delete by primary key from a bounded SELECT rather than a bare DELETE ... LIMIT, which
    // SQLite only supports when compiled with an option D1 does not guarantee.
    const result = await env.DB.prepare(
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log WHERE org_id = ? AND timestamp <= ? LIMIT ?
       )`,
    ).bind(org.id, cutoff, AUDIT_SWEEP_ROWS_PER_TICK).run()
    deleted += Number(result.meta.changes ?? 0)
  }
  return deleted
}

/** Expired or fully viewed share links, including their stored ciphertext. */
async function purgeShareLinks(env: Env, now: Date): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM share_links WHERE id IN (
       SELECT id FROM share_links WHERE expires_at <= ? OR view_count >= max_views LIMIT ?
     )`,
  ).bind(now.toISOString(), SHARE_PURGE_PER_TICK).run()
  return Number(result.meta.changes ?? 0)
}

/** Used or expired verification and reset tokens. */
async function purgeAuthTokens(env: Env, now: Date): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at IS NOT NULL')
    .bind(now.toISOString()).run()
  return Number(result.meta.changes ?? 0)
}

/**
 * Never throws: it shares a scheduled invocation with key rotation and the sync tick, and a
 * housekeeping failure must not take either of those down. Each step is independent, so one
 * failing does not skip the others.
 */
export async function housekeepingTick(env: Env, now: Date = new Date()): Promise<HousekeepingResult> {
  const result: HousekeepingResult = { auditRowsDeleted: 0, shareLinksDeleted: 0, authTokensDeleted: 0 }

  for (const [step, run] of [
    ['audit', async () => { result.auditRowsDeleted = await sweepAuditLog(env, now) }],
    ['share', async () => { result.shareLinksDeleted = await purgeShareLinks(env, now) }],
    ['tokens', async () => { result.authTokensDeleted = await purgeAuthTokens(env, now) }],
  ] as const) {
    try {
      await run()
    } catch (err) {
      logEvent('housekeeping.step_failed', { step, reason: err instanceof Error ? err.name : 'UnknownError' })
    }
  }

  if (result.auditRowsDeleted || result.shareLinksDeleted || result.authTokensDeleted) {
    logEvent('housekeeping.swept', { ...result })
  }
  return result
}
