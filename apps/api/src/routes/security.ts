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

  const job = await c.env.DB.prepare(
    'SELECT status, phase, started_at, completed_at FROM key_rotations ORDER BY started_at DESC LIMIT 1',
  ).first<{ status: string; phase: string; started_at: string; completed_at: string | null }>()

  const versionsInUse = new Set([...Object.keys(secrets), ...Object.keys(history), ...Object.keys(connections)])
  const oldVersionsInUse = [...versionsInUse].filter((v) => v !== active?.version).sort()

  return c.json({
    data: {
      activeVersion: active?.version ?? null,
      rows: { secrets, history, connections },
      oldVersionsInUse,
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
