import { Hono } from 'hono'
import type { Env } from '../index'
import { requireAuth, requireRole } from '../middleware/auth'

const router = new Hono<{ Bindings: Env }>()

// GET /api/security/key-rotation - read-only encryption key status for the caller's organisation.
// Counts only: no secret ids, keys, wrapped DEKs or ciphertext. Starting or retiring a
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

  const secrets: Record<string, number> = {}
  const history: Record<string, number> = {}
  for (const r of secretRows.results ?? []) secrets[r.version] = r.n
  for (const r of historyRows.results ?? []) history[r.version] = r.n

  const job = await c.env.DB.prepare(
    'SELECT status, phase, rewrapped, skipped, failed, started_at, completed_at, last_error_code FROM key_rotations ORDER BY started_at DESC LIMIT 1',
  ).first<{ status: string; phase: string; rewrapped: number; skipped: number; failed: number; started_at: string; completed_at: string | null; last_error_code: string | null }>()

  const versionsInUse = new Set([...Object.keys(secrets), ...Object.keys(history)])
  const oldVersionsInUse = [...versionsInUse].filter((v) => v !== active?.version).sort()

  return c.json({
    data: {
      activeVersion: active?.version ?? null,
      rows: { secrets, history },
      oldVersionsInUse,
      job: job
        ? {
            status: job.status,
            phase: job.phase,
            rewrapped: job.rewrapped,
            skipped: job.skipped,
            failed: job.failed,
            startedAt: job.started_at,
            completedAt: job.completed_at,
            errorCode: job.last_error_code,
          }
        : null,
    },
  })
})

export { router as securityRoutes }
