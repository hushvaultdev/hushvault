import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { requireAuth, requireRole, shareAccessRateLimit } from '../middleware/auth'
import { getRequestIp, writeAuditLog } from '../lib/security'

export const shareRoutes = new Hono<{ Bindings: Env }>()

const shareSchema = z.object({
  encryptedPayload: z.string().min(1).max(65536),
  expiresAt: z.string().datetime().optional(),
  maxViews: z.number().int().min(1).max(100).optional(),
})

const DEFAULT_TTL_MS = 60 * 60 * 1000
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

function webBaseUrl(env: Env): string {
  const configured = env.WEB_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return env.ENVIRONMENT === 'production' ? 'https://hushvault.dev' : 'http://localhost:3000'
}

// POST /api/share — create a one-time share link
shareRoutes.post('/', requireAuth, requireRole('member'), zValidator('json', shareSchema), async (c) => {
  const auth = c.get('auth')
  const { encryptedPayload, expiresAt, maxViews } = c.req.valid('json')
  const now = Date.now()

  let expiresAtMs = now + DEFAULT_TTL_MS
  if (expiresAt !== undefined) {
    expiresAtMs = new Date(expiresAt).getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'expiresAt must be in the future' }, 400)
    }
    if (expiresAtMs > now + MAX_TTL_MS) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'expiresAt must be within 7 days' }, 400)
    }
  }

  const id = createPrefixedId('sh')
  const token = createPrefixedId('tok')

  await c.env.DB.prepare(
    'INSERT INTO share_links (id, token, encrypted_payload, expires_at, max_views, view_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    token,
    encryptedPayload,
    // Always stored as a canonical ISO string so string comparison on read is correct.
    new Date(expiresAtMs).toISOString(),
    maxViews ?? 1,
    0,
    auth.userId,
    new Date(now).toISOString(),
  ).run()

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'share.create',
    resourceType: 'share_link',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { token, url: `${webBaseUrl(c.env)}/share/${token}` } }, 201)
})

// GET /api/share/:token — retrieve share link payload
shareRoutes.get('/:token', shareAccessRateLimit, async (c) => {
  c.header('Cache-Control', 'no-store')
  const token = c.req.param('token')

  // Single atomic statement: concurrent requests cannot exceed max_views.
  // Missing, expired and exhausted links are indistinguishable to the caller.
  const row = await c.env.DB.prepare(
    'UPDATE share_links SET view_count = view_count + 1 WHERE token = ? AND view_count < max_views AND expires_at > ? RETURNING id, encrypted_payload, created_by',
  )
    .bind(token, new Date().toISOString())
    .first<{ id: string; encrypted_payload: string; created_by: string | null }>()

  if (!row) {
    return c.json({ error: 'NOT_FOUND', message: 'Share link unavailable' }, 404)
  }

  // Best-effort audit (never includes the token); must not block delivery.
  try {
    if (row.created_by) {
      const org = await c.env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
        .bind(row.created_by)
        .first<{ org_id: string }>()
      if (org) {
        await writeAuditLog(c.env, {
          orgId: org.org_id,
          actorId: null,
          actorType: 'system',
          action: 'share.access',
          resourceType: 'share_link',
          resourceId: row.id,
          ip: getRequestIp(c),
          userAgent: c.req.header('user-agent'),
        })
      }
    }
  } catch {
    // audit failure is intentionally swallowed
  }

  return c.json({ data: { encryptedPayload: row.encrypted_payload } })
})
