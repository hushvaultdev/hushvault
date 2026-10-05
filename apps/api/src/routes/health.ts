import { Hono } from 'hono'
import type { Env } from '../index'
import { logEvent } from '../lib/security'

/**
 * A key that HushVault never writes. The probe reads it and expects `null`.
 *
 * Why a read of an absent key, and not a write-then-read round trip (issue #83):
 *  - It must not write a secret, and it must not write at all. KV's free plan caps writes and
 *    deletes per day while reads are effectively unmetered, so a probe that wrote once a minute
 *    (~1,440/day for one external monitor) would itself exhaust the write quota this check
 *    exists to detect — and a second monitor would double it.
 *  - `get` on a missing key still round-trips the binding, so a deleted or unbound namespace,
 *    a revoked binding and an account-level KV failure all surface.
 *  - It distinguishes the two outcomes that matter: a resolved promise (KV answered, whether or
 *    not the key exists) versus a rejected one (KV could not answer). "Absent" is the expected
 *    healthy answer here, so there is nothing to confuse it with.
 *
 * Known limit, stated so nobody reads more into a green check than it carries: Cloudflare caches
 * KV lookups (misses included) at the edge, so a healthy answer can come from cache rather than
 * from the central store, and a write-quota failure is only visible to the request that writes.
 * This probe proves the binding resolves and KV is reachable; it does not prove writes succeed.
 * `housekeeping.orphan_blobs` and `secret.decrypt_failed` are the signals for that.
 */
const KV_PROBE_KEY = 'health:probe'

/**
 * How long one probe result is served to further callers.
 *
 * `/health` is mounted outside `/api/*`, so it carries neither `requireAuth` nor the global
 * per-IP limiter — deliberately, because a monitor must be able to reach it without a token and
 * must not be throttled into a false alarm. That makes it the one unauthenticated route that can
 * drive work in both stores, and after #83 each request drove a D1 read AND a KV read. Anyone
 * could then flood it to burn the very quotas the probe exists to report on.
 *
 * Collapsing to one probe per window per isolate removes that: an external monitor at 1/min
 * still probes on every request (60s > the window) and sees an outage within one poll, while a
 * flood costs one probe per window no matter how many requests arrive. Concurrent callers share
 * the in-flight probe, which matters most when a store is slow rather than down — that is when
 * requests pile up fastest.
 *
 * Keep this well under a monitor's interval: it bounds how stale a reported recovery can be.
 */
export const HEALTH_CACHE_MS = 5_000

type ProbeStatus = 'ok' | 'down' | 'unconfigured'
type HealthChecks = { db: ProbeStatus; kv: ProbeStatus }

async function probeDb(env: Env): Promise<ProbeStatus> {
  try {
    await env.DB.prepare('SELECT 1 AS ok').first()
    return 'ok'
  } catch {
    return 'down'
  }
}

async function probeKv(env: Env): Promise<ProbeStatus> {
  const kv = env.SECRETS_KV as Env['SECRETS_KV'] | undefined
  // A missing binding is not a lesser fault than an unreachable one: every secret value lives
  // in KV, so either way nothing can be read. It is reported separately because the fix differs
  // (wrangler.toml / deploy versus a Cloudflare incident).
  if (!kv) return 'unconfigured'
  try {
    await kv.get(KV_PROBE_KEY)
    return 'ok'
  } catch {
    return 'down'
  }
}

let cached: { at: number; checks: HealthChecks } | null = null
let inFlight: Promise<HealthChecks> | null = null

/** Drops the cached probe result. Exported for tests; nothing in a request path calls it. */
export function resetHealthCache(): void {
  cached = null
  inFlight = null
}

/**
 * The probe result, fresh or from the window. `fresh` is false for a cached answer, so a flood
 * cannot also flood the log with `health.degraded` — while a store stays down the line still
 * fires once per window, which is what an alert needs.
 *
 * Probed in parallel and reported independently so the body says WHICH store failed: D1 alone
 * down means the API is unusable, KV alone down means metadata still answers while every secret
 * value is unreadable, and one flat `status: degraded` could not tell an operator those apart.
 */
async function currentHealth(env: Env): Promise<{ checks: HealthChecks; fresh: boolean }> {
  if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) return { checks: cached.checks, fresh: false }
  // A caller that joins a probe already running gets its result but does not re-log it.
  if (inFlight) return { checks: await inFlight, fresh: false }

  const run = (async (): Promise<HealthChecks> => {
    const [db, kv] = await Promise.all([probeDb(env), probeKv(env)])
    const checks: HealthChecks = { db, kv }
    cached = { at: Date.now(), checks }
    return checks
  })()
  inFlight = run
  try {
    return { checks: await run, fresh: true }
  } finally {
    if (inFlight === run) inFlight = null
  }
}

export const healthRoutes = new Hono<{ Bindings: Env }>()

// GET /health — liveness of both stores a secret read needs.
healthRoutes.get('/', async (c) => {
  const { checks, fresh } = await currentHealth(c.env)

  if (checks.db === 'ok' && checks.kv === 'ok') {
    return c.json({ status: 'ok', version: '0.0.1', checks })
  }
  // `reason` keeps the original single-string contract for anything already matching on it
  // ('database' when D1 is the failure); `checks` is what a monitor should read.
  const reason = checks.db !== 'ok' ? 'database' : 'kv'
  if (fresh) logEvent('health.degraded', { ...checks, reason })
  return c.json({ status: 'degraded', version: '0.0.1', reason, checks }, 503)
})
