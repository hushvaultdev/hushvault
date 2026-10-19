// Operator alerting (issue #83). Until this existed, every failure mode in
// docs/OPERATIONS.md section 3 was a passive log line nobody reads, and the two
// ABSENCE conditions — the cron or the sync tick stopping — produced no signal at all.
//
// WHY THIS LIVES IN THE CRON, NOT IN logEvent. `logEvent` (lib/security.ts) takes no
// `env` and no `ctx`, so it cannot do I/O; threading a binding through all 12 call sites
// would put an email send on the request path, where a slow or failing provider becomes
// the user's problem. More importantly, an absence alert is only detectable from
// something that runs on a schedule and remembers the last time it saw a heartbeat.
// The cron is both. So: ticks record heartbeats, and the next tick evaluates them.
//
// WHAT IT NEVER DOES. No secret, key, DEK, token, recipient address or caller-supplied
// value is ever read, stored or mailed — alert bodies carry event names, opaque codes
// and counts, the same bar as `logEvent` (lib/security.ts:109-112). State lives in
// `system_state` (migration 0016), whose header makes the same promise.
//
// FAIL-SOFT, ALWAYS. `sendEmail` never throws (lib/email.ts:74), every `system_state`
// helper swallows its own errors (lib/system-state.ts:6-9), and every entry point here
// is wrapped. Alerting is observability: it must never be able to break the cron it
// rides on, or take down key rotation and sync with it.
import type { Env } from '../index'
import { sendEmail } from './email'
import { logEvent } from './security'
import { readSystemState, writeSystemState } from './system-state'
import { consumeIdentityLimit } from '../middleware/rate-limit'

/** Heartbeat keys in `system_state`. One per thing whose silence is itself the alert. */
export const HEARTBEAT_KEYS = {
  cron: 'alerts.last_cron_tick_at',
  sync: 'alerts.last_sync_tick_at',
} as const

/** Dedupe markers, so a condition that persists mails once per window, not once per minute. */
const DEDUPE_PREFIX = 'alerts.last_sent.'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a heartbeat may be missing before it is an alert. OPERATIONS.md section 3
 * specifies 10 minutes for both cron and sync absence. The cron runs every minute, so
 * ten consecutive misses is unambiguous rather than a single slow invocation.
 */
const ABSENCE_THRESHOLD_MS = 10 * 60 * 1000

/**
 * Minimum gap between two emails about the SAME alert key. A condition like
 * `key_rotation.stalled` persists until an operator acts; at one cron tick per minute an
 * undeduped alert would send 1,440 emails a day and bury the next distinct failure.
 */
const RESEND_AFTER_MS = 60 * 60 * 1000

/**
 * Daily ceiling on alert emails, enforced through the same durable limiter
 * `spendEmailBudget` uses (lib/account-security.ts:46) so alerts cannot consume the
 * transactional-mail budget that carries verification and password-reset mail. A storm
 * must never cost a user their ability to reset a password.
 */
const ALERT_DAILY_BUDGET = 50

export type AlertSeverity = 'critical' | 'warning'

export type Alert = {
  /** Stable identity for dedupe. Usually the log event name, e.g. `key_rotation.stalled`. */
  key: string
  severity: AlertSeverity
  /** One line of human summary. Event names, codes and counts only. */
  summary: string
  /** Optional non-secret detail: codes, counts, labels. Never caller-supplied values. */
  detail?: Record<string, string | number | boolean | null>
}

function recipient(env: Env): string | null {
  const to = env.ALERT_EMAIL_TO?.trim()
  return to ? to : null
}

/** Opaque, non-secret body. Mirrors the structured log line so the two can be correlated. */
function render(env: Env, alert: Alert): { subject: string; text: string; html: string } {
  const environment = env.ENVIRONMENT ?? 'unknown'
  const tag = alert.severity === 'critical' ? 'CRITICAL' : 'WARNING'
  const subject = `[HushVault ${environment}] ${tag}: ${alert.key}`
  const lines = [
    alert.summary,
    '',
    `event:       ${alert.key}`,
    `severity:    ${alert.severity}`,
    `environment: ${environment}`,
    `observed at: ${new Date().toISOString()}`,
  ]
  for (const [k, v] of Object.entries(alert.detail ?? {})) lines.push(`${k}: ${String(v)}`)
  lines.push('', 'Runbook: docs/OPERATIONS.md section 3 (What to monitor).')
  const text = lines.join('\n')
  // No caller-supplied values reach here, so there is nothing to escape; keep it plain.
  const html = `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
  return { subject, text, html }
}

/**
 * Send one alert, subject to dedupe and the daily budget. Returns what happened so the
 * cron can log it. Never throws.
 */
export async function raiseAlert(env: Env, alert: Alert): Promise<'sent' | 'deduped' | 'budget' | 'unconfigured' | 'failed'> {
  try {
    const to = recipient(env)
    if (!to) {
      // Deliberately quiet-ish: logged so a deployment without ALERT_EMAIL_TO is visible
      // in the log, but it must not itself become a per-minute noise source.
      logEvent('alerts.unconfigured', { key: alert.key })
      return 'unconfigured'
    }

    const dedupeKey = `${DEDUPE_PREFIX}${alert.key}`
    const last = await readSystemState(env, dedupeKey)
    if (last) {
      const age = Date.now() - new Date(last.updatedAt).getTime()
      if (Number.isFinite(age) && age < RESEND_AFTER_MS) {
        logEvent('alerts.deduped', { key: alert.key, ageMs: Math.round(age) })
        return 'deduped'
      }
    }

    const budget = await consumeIdentityLimit(env, {
      scope: 'email-send-alert',
      identity: 'global',
      limit: ALERT_DAILY_BUDGET,
      windowMs: DAY_MS,
    })
    if ('unavailable' in budget || !budget.allowed) {
      logEvent('alerts.budget_exhausted', { key: alert.key, limit: ALERT_DAILY_BUDGET })
      return 'budget'
    }

    const { subject, text, html } = render(env, alert)
    const result = await sendEmail(env, { to, subject, text, html })
    if (!result.ok) {
      logEvent('alerts.send_failed', { key: alert.key, code: result.code })
      return 'failed'
    }

    // Marker written only after a successful send, so a failed send retries next tick
    // rather than being suppressed for an hour by its own failure.
    await writeSystemState(env, dedupeKey, alert.severity, new Date().toISOString())
    logEvent('alerts.sent', { key: alert.key, severity: alert.severity })
    return 'sent'
  } catch {
    // Alerting must never break its caller. Nothing to report: the condition that
    // triggered this is already in the log via its own event.
    return 'failed'
  }
}

/** Record that a heartbeat happened. Called by the cron after each tick. */
export async function recordHeartbeat(env: Env, which: keyof typeof HEARTBEAT_KEYS, nowIso: string): Promise<void> {
  await writeSystemState(env, HEARTBEAT_KEYS[which], 'ok', nowIso)
}

/**
 * Evaluate the ABSENCE conditions: has a heartbeat gone quiet for longer than the
 * threshold? This runs inside the cron, which means it can only ever catch the *sync*
 * tick stopping while the cron itself still runs.
 *
 * A cron that stops entirely cannot detect its own absence — nothing inside the Worker
 * can. That requires an external watchdog (an uptime monitor hitting /health, or a
 * Cloudflare notification on the Worker's cron failures). The cron heartbeat is still
 * recorded here so such a watchdog has a durable timestamp to read, and so the gap is
 * documented rather than silently assumed covered.
 */
export async function evaluateAbsence(env: Env, nowMs: number): Promise<void> {
  for (const which of ['sync'] as const) {
    try {
      const state = await readSystemState(env, HEARTBEAT_KEYS[which])
      if (!state) continue // first run after deploy, or migrations behind: nothing to compare
      const age = nowMs - new Date(state.updatedAt).getTime()
      if (!Number.isFinite(age) || age < ABSENCE_THRESHOLD_MS) continue
      await raiseAlert(env, {
        key: `${which}.tick.absent`,
        severity: 'critical',
        summary: `The ${which} tick has not run for ${Math.round(age / 60000)} minutes.`,
        detail: { staleMs: Math.round(age), thresholdMs: ABSENCE_THRESHOLD_MS },
      })
    } catch {
      // As everywhere here: never break the cron.
    }
  }
}

/**
 * Evaluate the PRESENCE conditions visible from one cron tick's own results. The wider
 * catalogue in OPERATIONS.md section 3 is emitted from inside the ticks themselves; this
 * covers what the tick outcomes reveal, which is where a thrown tick first becomes
 * visible at all.
 */
export async function evaluateTickOutcome(
  env: Env,
  outcome: { rotation: string; rotationCode: string | null; sync: string; housekeeping: string },
): Promise<void> {
  if (outcome.rotation === 'threw' || outcome.rotation === 'error') {
    await raiseAlert(env, {
      key: 'key_rotation.tick_failed',
      severity: 'critical',
      summary: 'The key-rotation tick failed. Wrapped DEKs may not be migrating.',
      detail: { state: outcome.rotation, code: outcome.rotationCode },
    })
  }
  if (outcome.sync === 'threw') {
    await raiseAlert(env, {
      key: 'sync.tick_failed',
      severity: 'warning',
      summary: 'The sync tick threw. Outbound secret sync may be stalled.',
    })
  }
  if (outcome.housekeeping === 'threw') {
    await raiseAlert(env, {
      key: 'housekeeping.tick_failed',
      severity: 'warning',
      summary: 'The housekeeping tick threw. Retention and purge deletes are not running.',
    })
  }
}
