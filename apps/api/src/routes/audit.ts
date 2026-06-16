import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { requireAuth } from '../middleware/auth'
import {
  AUDIT_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  canComplianceExport,
  effectiveRetentionDays,
  loadOrgRetention,
  retentionCutoffIso,
} from '../lib/audit-retention'

export const auditRoutes = new Hono<{ Bindings: Env }>()

auditRoutes.use('*', requireAuth)

// Hard cap on rows returned by the list endpoint (cursor-paginated page size).
const LIST_PAGE_SIZE = 100
// Hard cap on rows streamed by an export, to bound CPU/memory in the Worker.
const EXPORT_MAX_ROWS = 50_000

type AuditRow = {
  id: string
  org_id: string
  actor_id: string | null
  actor_type: string
  action: string
  resource_type: string | null
  resource_id: string | null
  ip: string | null
  user_agent: string | null
  timestamp: string
}

// Shared query-filter validation for list + export. All optional; org scoping
// is always applied server-side from the auth context (never from input).
const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  action: z.string().min(1).max(64).optional(),
  actorId: z.string().min(1).max(128).optional(),
  cursor: z.string().min(1).max(64).optional(),
})

const exportQuerySchema = listQuerySchema.extend({
  format: z.enum(['csv', 'json']).default('json'),
})

// Build the WHERE clause + bound params for an audit query. Always scopes to
// the caller's org and to the org's retention window; layers optional filters.
function buildFilters(opts: {
  orgId: string
  retentionCutoff: string | null
  from?: string
  to?: string
  action?: string
  actorId?: string
}): { clause: string; params: unknown[] } {
  const clauses: string[] = ['org_id = ?']
  const params: unknown[] = [opts.orgId]

  // Retention floor — never return rows outside the org's retention window,
  // even if the caller asks for an older `from`.
  if (opts.retentionCutoff) {
    clauses.push('timestamp > ?')
    params.push(opts.retentionCutoff)
  }
  if (opts.from) {
    clauses.push('timestamp >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    clauses.push('timestamp <= ?')
    params.push(opts.to)
  }
  if (opts.action) {
    clauses.push('action = ?')
    params.push(opts.action)
  }
  if (opts.actorId) {
    clauses.push('actor_id = ?')
    params.push(opts.actorId)
  }

  return { clause: clauses.join(' AND '), params }
}

function toApiRow(row: AuditRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ip: row.ip,
    userAgent: row.user_agent,
    timestamp: row.timestamp,
  }
}

// GET /api/audit/retention — current effective retention settings for the org.
// Registered before GET '/' purely for readability; Hono matches static paths
// unambiguously regardless of order.
auditRoutes.get('/retention', async (c) => {
  const auth = c.get('auth')
  const retention = await loadOrgRetention(c.env, auth.orgId)
  if (!retention) {
    return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  }

  const planMaxDays = AUDIT_RETENTION_DAYS[retention.plan] ?? DEFAULT_RETENTION_DAYS
  return c.json({
    data: {
      plan: retention.plan,
      planMaxDays,
      overrideDays: retention.auditRetentionDays,
      effectiveDays: effectiveRetentionDays(retention),
    },
  })
})

const retentionUpdateSchema = z.object({
  // null clears the override (revert to plan default); a positive integer sets
  // a shorter window. Values above the plan cap are clamped on read, not here.
  overrideDays: z.number().int().min(1).max(3650).nullable(),
})

// PUT /api/audit/retention — set or clear the org's retention override.
// Owners/admins only; members and viewers cannot change compliance settings.
auditRoutes.put('/retention', zValidator('json', retentionUpdateSchema), async (c) => {
  const auth = c.get('auth')
  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return c.json({ error: 'FORBIDDEN', message: 'Insufficient permissions' }, 403)
  }

  const { overrideDays } = c.req.valid('json')

  const result = await c.env.DB.prepare('UPDATE organisations SET audit_retention_days = ? WHERE id = ?')
    .bind(overrideDays, auth.orgId)
    .run()
  if (!result.success) {
    return c.json({ error: 'INTERNAL_ERROR', message: 'Could not update retention' }, 500)
  }

  const retention = await loadOrgRetention(c.env, auth.orgId)
  if (!retention) {
    return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  }
  const planMaxDays = AUDIT_RETENTION_DAYS[retention.plan] ?? DEFAULT_RETENTION_DAYS
  return c.json({
    data: {
      plan: retention.plan,
      planMaxDays,
      overrideDays: retention.auditRetentionDays,
      effectiveDays: effectiveRetentionDays(retention),
    },
  })
})

// GET /api/audit/export — compliance export of the org's audit log as CSV/JSON.
// Team/Enterprise plans only. Org-scoped, retention-filtered, capped row count.
auditRoutes.get('/export', zValidator('query', exportQuerySchema), async (c) => {
  const auth = c.get('auth')
  const { format, from, to, action, actorId } = c.req.valid('query')

  const retention = await loadOrgRetention(c.env, auth.orgId)
  if (!retention) {
    return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  }
  if (!canComplianceExport(retention.plan)) {
    return c.json(
      { error: 'PLAN_UPGRADE_REQUIRED', message: 'Compliance export requires the Team or Enterprise plan' },
      403,
    )
  }

  const retentionCutoff = retentionCutoffIso(effectiveRetentionDays(retention))
  const { clause, params } = buildFilters({ orgId: auth.orgId, retentionCutoff, from, to, action, actorId })

  const result = await c.env.DB.prepare(
    `SELECT id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, timestamp
     FROM audit_log WHERE ${clause}
     ORDER BY timestamp DESC, id DESC LIMIT ?`,
  )
    .bind(...params, EXPORT_MAX_ROWS)
    .all<AuditRow>()

  const rows = result.results ?? []
  const stamp = new Date().toISOString().slice(0, 10)

  if (format === 'csv') {
    const body = toCsv(rows)
    return c.body(body, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${stamp}.csv"`,
    })
  }

  const body = JSON.stringify({
    data: rows.map(toApiRow),
    total: rows.length,
    exportedAt: new Date().toISOString(),
  })
  return c.body(body, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-log-${stamp}.json"`,
  })
})

// GET /api/audit — list the org's audit log (retention-filtered, paginated).
// Supports from/to/action/actorId filters and keyset pagination via `cursor`.
auditRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const auth = c.get('auth')
  const { from, to, action, actorId, cursor } = c.req.valid('query')

  const retention = await loadOrgRetention(c.env, auth.orgId)
  if (!retention) {
    return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  }
  const retentionCutoff = retentionCutoffIso(effectiveRetentionDays(retention))

  const { clause, params } = buildFilters({ orgId: auth.orgId, retentionCutoff, from, to, action, actorId })

  // Total count within the (retention + filters) scope, before pagination.
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_log WHERE ${clause}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countRow?.total ?? 0

  // Keyset pagination: the cursor is the last id of the previous page. Rows are
  // ordered (timestamp DESC, id DESC); fetch rows ordered after the cursor row.
  const pageClauses = [clause]
  const pageParams = [...params]
  if (cursor) {
    const cursorRow = await c.env.DB.prepare('SELECT timestamp, id FROM audit_log WHERE id = ? AND org_id = ? LIMIT 1')
      .bind(cursor, auth.orgId)
      .first<{ timestamp: string; id: string }>()
    if (cursorRow) {
      pageClauses.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
      pageParams.push(cursorRow.timestamp, cursorRow.timestamp, cursorRow.id)
    }
  }

  const result = await c.env.DB.prepare(
    `SELECT id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, timestamp
     FROM audit_log WHERE ${pageClauses.join(' AND ')}
     ORDER BY timestamp DESC, id DESC LIMIT ?`,
  )
    .bind(...pageParams, LIST_PAGE_SIZE + 1)
    .all<AuditRow>()

  const rows = result.results ?? []
  const hasMore = rows.length > LIST_PAGE_SIZE
  const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null

  return c.json({ data: page.map(toApiRow), nextCursor, total })
})

const CSV_COLUMNS: Array<keyof AuditRow> = [
  'id',
  'timestamp',
  'action',
  'actor_id',
  'actor_type',
  'resource_type',
  'resource_id',
  'ip',
  'user_agent',
]

// RFC 4180 field escaping: wrap in quotes when the value contains a comma,
// quote, or newline; double any embedded quotes. Guards against breaking the
// CSV structure with delimiters/newlines from stored user-agent values.
function csvField(value: string | null): string {
  const s = value ?? ''
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function toCsv(rows: AuditRow[]): string {
  const header = CSV_COLUMNS.join(',')
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => csvField(row[col])).join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}
