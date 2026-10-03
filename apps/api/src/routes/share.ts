import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { requireAuth, requireRole, requireVerifiedEmailIfEnforced, shareAccessRateLimit } from '../middleware/auth'
import { getRequestIp, logEvent, writeAuditLog } from '../lib/security'

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
// requireVerifiedEmailIfEnforced is here for the same reason it is on api-keys: a share link
// is an exfiltration path, and someone who signed up with an address they do not own should
// not be able to use one. Without it the flag blocked API keys and left this route open.
shareRoutes.post('/', requireAuth, requireVerifiedEmailIfEnforced, requireRole('member'), zValidator('json', shareSchema), async (c) => {
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
    'INSERT INTO share_links (id, token, encrypted_payload, expires_at, max_views, view_count, created_by, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    token,
    encryptedPayload,
    // Always stored as a canonical ISO string so string comparison on read is correct.
    new Date(expiresAtMs).toISOString(),
    maxViews ?? 1,
    0,
    auth.userId,
    // Recorded here so the access audit row does not depend on the creator still existing.
    auth.orgId,
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
    'UPDATE share_links SET view_count = view_count + 1 WHERE token = ? AND view_count < max_views AND expires_at > ? RETURNING id, encrypted_payload, org_id',
  )
    .bind(token, new Date().toISOString())
    .first<{ id: string; encrypted_payload: string; org_id: string | null }>()

  if (!row) {
    return c.json({ error: 'NOT_FOUND', message: 'Share link unavailable' }, 404)
  }

  // A link created before migration 0015, by a user who has since been deleted, has no owner to
  // audit against. Delivering a secret that nothing can record is worse than reporting the link
  // unavailable, so this fails closed — with the same body as every other failure, so it is not
  // an oracle. The view is already consumed, which is the conservative direction.
  if (!row.org_id) {
    logEvent('share.unattributed_refused', { shareId: row.id })
    return c.json({ error: 'NOT_FOUND', message: 'Share link unavailable' }, 404)
  }

  // The audit row is awaited and not swallowed: the payload is only returned once the access is
  // recorded. It used to be best-effort inside an empty catch, so a failed write delivered the
  // secret silently.
  await writeAuditLog(c.env, {
    orgId: row.org_id,
    actorId: null,
    actorType: 'system',
    action: 'share.access',
    resourceType: 'share_link',
    resourceId: row.id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { encryptedPayload: row.encrypted_payload } })
})

// GET /api/share — the organisation's live links. Never the payload and never the token:
// knowing a link exists must not be enough to open it. Admins only, because this is the
// "what of ours is currently in flight" view.
shareRoutes.get('/', requireAuth, requireRole('admin'), async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT id, created_by, created_at, expires_at, max_views, view_count
       FROM share_links
      WHERE org_id = ? AND expires_at > ? AND view_count < max_views
      ORDER BY created_at DESC LIMIT 200`,
  ).bind(auth.orgId, new Date().toISOString()).all<{
    id: string; created_by: string | null; created_at: string; expires_at: string; max_views: number; view_count: number
  }>()

  return c.json({
    data: (rows.results ?? []).map((r) => ({
      id: r.id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxViews: r.max_views,
      viewCount: r.view_count,
    })),
  })
})

// DELETE /api/share/:id — revoke a link before it is opened.
//
// Pasting a share URL into the wrong channel used to be unrecoverable: there was no revoke, so
// the only option was to wait out a TTL of up to seven days with up to 100 views remaining. The
// row is deleted rather than marked, so the ciphertext stops existing too. Scoped by org_id, and
// by id (not token) so revoking never requires handling the secret-bearing part of the URL.
shareRoutes.delete('/:id', requireAuth, requireRole('member'), async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()

  const result = await c.env.DB.prepare('DELETE FROM share_links WHERE id = ? AND org_id = ?')
    .bind(id, auth.orgId).run()
  if (!result.success || !result.meta.changes) {
    return c.json({ error: 'NOT_FOUND', message: 'Share link not found' }, 404)
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'share.revoke',
    resourceType: 'share_link',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { revoked: true } })
})
