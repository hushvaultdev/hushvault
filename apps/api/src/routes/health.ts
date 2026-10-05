import { Hono } from 'hono'
import type { Env } from '../index'
import { logEvent } from '../lib/security'

export const healthRoutes = new Hono<{ Bindings: Env }>()

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

type ProbeStatus = 'ok' | 'down' | 'unconfigured'

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

// GET /health — liveness of both stores a secret read needs. Probed independently and in
// parallel so the body says WHICH one failed: D1 alone down means the API is unusable, KV alone
// down means metadata still answers while every secret value is unreadable, and one flat
// `status: degraded` could not tell an operator those apart.
healthRoutes.get('/', async (c) => {
  const [db, kv] = await Promise.all([probeDb(c.env), probeKv(c.env)])
  const checks = { db, kv }

  if (db === 'ok' && kv === 'ok') {
    return c.json({ status: 'ok', version: '0.0.1', checks })
  }
  // `reason` keeps the original single-string contract for anything already matching on it
  // ('database' when D1 is the failure); `checks` is what a monitor should read.
  const reason = db !== 'ok' ? 'database' : 'kv'
  logEvent('health.degraded', { db, kv, reason })
  return c.json({ status: 'degraded', version: '0.0.1', reason, checks }, 503)
})
