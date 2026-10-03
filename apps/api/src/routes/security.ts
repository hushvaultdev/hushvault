import { Hono } from 'hono'
import type { Env } from '../index'
import { requireAuth, requireRole } from '../middleware/auth'

const router = new Hono<{ Bindings: Env }>()

// GET /api/security/key-rotation - read-only encryption key status for the caller's organisation.
// The job block is deployment-wide, so it carries no counters or error codes (only status and
// timestamps); row counts are scoped to the caller's organisation. No secret ids, keys, wrapped DEKs or ciphertext. Starting or retiring a
// rotation is an operator action (deploy), never available through this API.
router.get('/key-rotation', requireAuth, requireRole('admin'), async (c) => {
  const auth = c.get('auth')

  const active = await c.env.DB.prepare("SELECT version FROM encryption_keys WHERE status = 'active' LIMIT 1").first<{ version: string }>()

  const secretRows = await c.env.DB.prepare(
    'SELECT s.key_version AS version, count(*) AS n FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id = ? GROUP BY s.key_version',
  ).bind(auth.orgId).all<{ version: string; n: number }>()
  const historyRows = await c.env.DB.prepare(
    'SELECT h.key_version AS version, count(*) AS n FROM secret_history h INNER JOIN secrets s ON s.id = h.secret_id INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id = ? GROUP BY h.key_version',
  ).bind(auth.orgId).all<{ version: string; n: number }>()

  const connectionRows = await c.env.DB.prepare(
    'SELECT key_version AS version, count(*) AS n FROM integration_connections WHERE org_id = ? GROUP BY key_version',
  ).bind(auth.orgId).all<{ version: string; n: number }>()

  const secrets: Record<string, number> = {}
  const history: Record<string, number> = {}
  const connections: Record<string, number> = {}
  for (const r of connectionRows.results ?? []) connections[r.version] = r.n
  for (const r of secretRows.results ?? []) secrets[r.version] = r.n
  for (const r of historyRows.results ?? []) history[r.version] = r.n

  // Rows still on the pre-AAD blob format (enc_version 1). Rotation re-wraps their DEK and
  // advances key_version without adding an AAD tag — correctly, because the tag belongs to the
  // value blob, not the wrap — so the job can finish `completed` with these rows still present.
  // Turning on ENFORCE_AAD then makes every read of an affected environment fail as a unit, and
  // nothing in the API used to show that this was pending. Report it so the operator can see it
  // before flipping the flag.
  const legacySecrets = await c.env.DB.prepare(
    'SELECT count(*) AS n FROM secrets s INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id = ? AND s.enc_version = 1',
  ).bind(auth.orgId).first<{ n: number }>()
  const legacyHistory = await c.env.DB.prepare(
    'SELECT count(*) AS n FROM secret_history h INNER JOIN secrets s ON s.id = h.secret_id INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id = ? AND h.enc_version = 1',
  ).bind(auth.orgId).first<{ n: number }>()

  // Quarantined rows from the latest job: a row the engine could not re-wrap stays on its old
  // key version, so retiring that key destroys it. Surfaced as a count plus the distinct codes,
  // never row ids.
  const job = await c.env.DB.prepare(
    'SELECT id, status, phase, started_at, completed_at FROM key_rotations ORDER BY started_at DESC LIMIT 1',
  ).first<{ id: string; status: string; phase: string; started_at: string; completed_at: string | null }>()

  let unresolvedRows = 0
  let failureCodes: string[] = []
  if (job) {
    const failures = await c.env.DB.prepare(
      'SELECT error_code AS code, count(*) AS n FROM key_rotation_failures WHERE rotation_id = ? GROUP BY error_code',
    ).bind(job.id).all<{ code: string; n: number }>()
    for (const row of failures.results ?? []) unresolvedRows += row.n
    failureCodes = (failures.results ?? []).map((r) => r.code).sort()
  }

  const versionsInUse = new Set([...Object.keys(secrets), ...Object.keys(history), ...Object.keys(connections)])
  const oldVersionsInUse = [...versionsInUse].filter((v) => v !== active?.version).sort()

  const legacyEncVersionRows = (legacySecrets?.n ?? 0) + (legacyHistory?.n ?? 0)

  return c.json({
    data: {
      activeVersion: active?.version ?? null,
      rows: { secrets, history, connections },
      oldVersionsInUse,
      /** Rows still on enc_version 1. ENFORCE_AAD will refuse these, so it must stay off until 0. */
      legacyEncVersionRows,
      /** Rows the last rotation could not re-wrap. Retiring the old key while this is > 0 loses them. */
      unresolvedRows,
      failureCodes,
      /**
       * The single question the operator actually has: is it safe to retire the old key? Only when
       * nothing is left on another version and nothing was quarantined. A `completed` job alone has
       * never been a sufficient answer.
       */
      safeToRetireOldKeys: oldVersionsInUse.length === 0 && unresolvedRows === 0,
      job: job
        ? {
            status: job.status,
            phase: job.phase,
            startedAt: job.started_at,
            completedAt: job.completed_at,
          }
        : null,
    },
  })
})

export { router as securityRoutes }
