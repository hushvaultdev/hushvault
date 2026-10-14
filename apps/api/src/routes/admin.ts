// Platform admin: manage an organisation's plan without raw SQL (issue #102/#103). Every route
// requires requireAuth + requirePlatformAdmin, never an org role — a platform admin acts across
// every tenant, which is exactly why this is the smallest, most carefully audited surface in the
// API. No route here ever returns a secret value, a credential, or any other tenant's data beyond
// plan/usage counts. Suspend/reactivate is deliberately NOT here yet (follow-up issue): it needs an
// enforcement point on the auth hot path and deserves its own review.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { PLAN_ENTITLEMENTS, type PlanTier } from '../lib/entitlements'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { validationHook } from '../lib/validation'
import { requireAuth } from '../middleware/auth'
import { requirePlatformAdmin } from '../middleware/platform-admin'

export const adminRoutes = new Hono<{ Bindings: Env }>()

adminRoutes.use('*', requireAuth, requirePlatformAdmin)

const PLAN_TIERS = Object.keys(PLAN_ENTITLEMENTS) as [PlanTier, ...PlanTier[]]
const ADMIN_LIST_LIMIT = 50

type OrgListRow = {
  id: string
  name: string
  slug: string
  plan: string
  plan_expires_at: string | null
  created_at: string
  member_count: number
}

function toOrgDto(row: OrgListRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    planExpiresAt: row.plan_expires_at,
    memberCount: row.member_count,
    createdAt: row.created_at,
  }
}

// GET /api/admin/orgs - list organisations, newest first. Plan/usage only, never secrets.
adminRoutes.get('/orgs', async (c) => {
  const cursor = c.req.query('cursor')
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.plan, o.plan_expires_at, o.created_at,
            (SELECT COUNT(*) FROM members m WHERE m.org_id = o.id) AS member_count
       FROM organisations o
      WHERE (?1 IS NULL OR o.created_at < (SELECT created_at FROM organisations WHERE id = ?1))
      ORDER BY o.created_at DESC
      LIMIT ?2`,
  ).bind(cursor ?? null, ADMIN_LIST_LIMIT + 1).all<OrgListRow>()
  const page = results.slice(0, ADMIN_LIST_LIMIT)
  const nextCursor = results.length > ADMIN_LIST_LIMIT ? page[page.length - 1]?.id ?? null : null
  return c.json({ data: page.map(toOrgDto), nextCursor })
})

// GET /api/admin/orgs/:id - one organisation's plan, usage and entitlements.
adminRoutes.get('/orgs/:id', async (c) => {
  const orgId = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.plan, o.plan_expires_at, o.created_at,
            (SELECT COUNT(*) FROM members m WHERE m.org_id = o.id) AS member_count
       FROM organisations o WHERE o.id = ? LIMIT 1`,
  ).bind(orgId).first<OrgListRow>()
  if (!row) return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  const [{ count: projectCount } = { count: 0 }] = (
    await c.env.DB.prepare('SELECT COUNT(*) AS count FROM projects WHERE org_id = ?').bind(orgId).all<{ count: number }>()
  ).results
  const [{ count: syncTargetCount } = { count: 0 }] = (
    await c.env.DB.prepare('SELECT COUNT(*) AS count FROM sync_targets WHERE org_id = ? AND status = \'active\'').bind(orgId).all<{ count: number }>()
  ).results
  return c.json({
    data: {
      ...toOrgDto(row),
      entitlements: PLAN_ENTITLEMENTS[(row.plan in PLAN_ENTITLEMENTS ? row.plan : 'free') as PlanTier],
      usage: { projectCount, syncTargetCount },
    },
  })
})

const setPlanSchema = z.object({ plan: z.enum(PLAN_TIERS) })

// PUT /api/admin/orgs/:id/plan - set a plan with no expiry (an operator override, not a comp grant).
// The one and only way an organisation's plan changes outside this grant/revoke pair or a future
// Stripe webhook; never reachable by an org's own members (see plan-limits.ts for why).
adminRoutes.put('/orgs/:id/plan', zValidator('json', setPlanSchema, validationHook), async (c) => {
  const orgId = c.req.param('id')
  const { plan } = c.req.valid('json')
  const before = await c.env.DB.prepare('SELECT plan FROM organisations WHERE id = ? LIMIT 1').bind(orgId).first<{ plan: string }>()
  if (!before) return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  await c.env.DB.prepare('UPDATE organisations SET plan = ?, plan_expires_at = NULL WHERE id = ?').bind(plan, orgId).run()
  await writeAuditLog(c.env, {
    orgId,
    actorId: c.get('platformAdminId'),
    actorType: 'user',
    action: 'admin.org.plan_set',
    resourceType: 'organisation',
    resourceId: orgId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    metadata: { from: before.plan, to: plan },
  })
  return c.json({ data: { id: orgId, plan, planExpiresAt: null } })
})

const grantCompSchema = z.object({ plan: z.enum(PLAN_TIERS.filter((p) => p !== 'free') as [PlanTier, ...PlanTier[]]), days: z.number().int().min(1).max(365) })

// POST /api/admin/orgs/:id/comp - grant a time-boxed plan (issue #104). Reverts to free with data
// kept by the housekeeping sweep (sweepExpiredComps) when plan_expires_at passes; never deletes
// anything. Granting again while one is active simply overwrites it (replace, not stack).
adminRoutes.post('/orgs/:id/comp', zValidator('json', grantCompSchema, validationHook), async (c) => {
  const orgId = c.req.param('id')
  const { plan, days } = c.req.valid('json')
  const before = await c.env.DB.prepare('SELECT plan FROM organisations WHERE id = ? LIMIT 1').bind(orgId).first<{ plan: string }>()
  if (!before) return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
  await c.env.DB.prepare('UPDATE organisations SET plan = ?, plan_expires_at = ? WHERE id = ?').bind(plan, expiresAt, orgId).run()
  await writeAuditLog(c.env, {
    orgId,
    actorId: c.get('platformAdminId'),
    actorType: 'user',
    action: 'admin.org.comp_grant',
    resourceType: 'organisation',
    resourceId: orgId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    metadata: { from: before.plan, to: plan, days },
  })
  return c.json({ data: { id: orgId, plan, planExpiresAt: expiresAt } }, 201)
})

// DELETE /api/admin/orgs/:id/comp - revoke an active comp immediately, reverting to free with data
// kept. A no-op (same result) if the org's plan has no expiry: there is nothing to revoke.
adminRoutes.delete('/orgs/:id/comp', async (c) => {
  const orgId = c.req.param('id')
  const before = await c.env.DB.prepare('SELECT plan, plan_expires_at FROM organisations WHERE id = ? LIMIT 1')
    .bind(orgId).first<{ plan: string; plan_expires_at: string | null }>()
  if (!before) return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
  if (before.plan_expires_at === null) return c.json({ data: { id: orgId, plan: before.plan, planExpiresAt: null } })
  await c.env.DB.prepare("UPDATE organisations SET plan = 'free', plan_expires_at = NULL WHERE id = ?").bind(orgId).run()
  await writeAuditLog(c.env, {
    orgId,
    actorId: c.get('platformAdminId'),
    actorType: 'user',
    action: 'admin.org.comp_revoke',
    resourceType: 'organisation',
    resourceId: orgId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    metadata: { from: before.plan },
  })
  return c.json({ data: { id: orgId, plan: 'free', planExpiresAt: null } })
})
