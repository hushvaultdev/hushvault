import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { requireAuth, shareAccessRateLimit } from '../middleware/auth'
import { getRequestIp, writeAuditLog } from '../lib/security'

export const shareRoutes = new Hono<{ Bindings: Env }>()

const shareSchema = z.object({
  encryptedPayload: z.string().min(1).max(65536),
  expiresAt: z.string().datetime().optional(),
  maxViews: z.number().int().min(1).max(100).optional(),
})

// POST /api/share — create a one-time share link
shareRoutes.post('/', requireAuth, zValidator('json', shareSchema), async (c) => {
  const auth = c.get('auth')
  const { encryptedPayload, expiresAt, maxViews } = c.req.valid('json')
  const id = createPrefixedId('sh')
  const token = createPrefixedId('tok')

  await c.env.DB.prepare(
    'INSERT INTO share_links (id, token, encrypted_payload, expires_at, max_views, view_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    token,
    encryptedPayload,
    expiresAt ?? new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    maxViews ?? 1,
    0,
    auth.userId,
    new Date().toISOString(),
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

  return c.json({ data: { token, url: `https://hushvault.dev/share/${token}` } }, 201)
})

// GET /api/share/:token — retrieve share link payload
shareRoutes.get('/:token', shareAccessRateLimit, async (c) => {
  const token = c.req.param('token')
  const row = await c.env.DB.prepare('SELECT id, encrypted_payload, expires_at, max_views, view_count FROM share_links WHERE token = ? LIMIT 1')
    .bind(token)
    .first<{ id: string; encrypted_payload: string; expires_at: string; max_views: number; view_count: number }>()

  if (!row) {
    return c.json({ error: 'NOT_FOUND', message: 'Share link not found' }, 404)
  }

  const expired = new Date(row.expires_at).getTime() <= Date.now()
  if (expired || row.view_count >= row.max_views) {
    return c.json({ error: 'NOT_FOUND', message: 'Share link unavailable' }, 404)
  }

  await c.env.DB.prepare('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?').bind(row.id).run()
  return c.json({ data: { encryptedPayload: row.encrypted_payload } })
})
