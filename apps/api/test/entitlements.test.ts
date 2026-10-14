import { describe, expect, it } from 'vitest'
import { FREE_PLAN_MAX_SYNC_TARGETS } from '@hushvault/shared/integrations'
import { AUDIT_RETENTION_DAYS, COMPLIANCE_EXPORT_PLANS, DEFAULT_RETENTION_DAYS } from '../src/lib/audit-retention'
import { FREE_ENTITLEMENTS, PLAN_ENTITLEMENTS, entitlementsForPlan, loadEntitlements } from '../src/lib/entitlements'
import { FREE_SYNC_LIMITS, SYNC_PLAN_LIMITS, syncLimitsForPlan } from '../src/lib/plan-limits'
import { createTestEnv, seedUser } from './helpers/env'

describe('entitlementsForPlan: the limits that exist today are unchanged', () => {
  it('sync targets and automatic runs per hour', () => {
    expect(entitlementsForPlan('free')).toMatchObject({ maxSyncTargets: FREE_PLAN_MAX_SYNC_TARGETS, autoRunsPerHour: 60 })
    expect(entitlementsForPlan('pro')).toMatchObject({ maxSyncTargets: 25, autoRunsPerHour: 600 })
    expect(entitlementsForPlan('team')).toMatchObject({ maxSyncTargets: 100, autoRunsPerHour: 2_000 })
    expect(entitlementsForPlan('enterprise')).toMatchObject({ maxSyncTargets: -1, autoRunsPerHour: -1 })
  })

  it('audit retention days and compliance export', () => {
    expect(entitlementsForPlan('free')).toMatchObject({ auditRetentionDays: 7, complianceExport: false })
    expect(entitlementsForPlan('pro')).toMatchObject({ auditRetentionDays: 90, complianceExport: false })
    expect(entitlementsForPlan('team')).toMatchObject({ auditRetentionDays: 365, complianceExport: true })
    expect(entitlementsForPlan('enterprise')).toMatchObject({ auditRetentionDays: -1, complianceExport: true })
  })

  it('reports the plan it resolved', () => {
    for (const plan of ['free', 'pro', 'team', 'enterprise'] as const) expect(entitlementsForPlan(plan).plan).toBe(plan)
  })
})

describe('entitlementsForPlan: caps with no decided numbers are unlimited placeholders', () => {
  it('projects, secrets, environments per project and seats are -1 on every plan until the market test sets them', () => {
    for (const e of Object.values(PLAN_ENTITLEMENTS)) {
      expect(e.maxProjects).toBe(-1)
      expect(e.maxSecrets).toBe(-1)
      expect(e.maxEnvironmentsPerProject).toBe(-1)
      expect(e.maxSeats).toBe(-1)
    }
  })
})

describe('entitlementsForPlan: fails closed', () => {
  it('maps an unknown, null or undefined plan to the free tier, reporting plan "free"', () => {
    for (const plan of ['nope', '', 'PRO', null, undefined]) {
      expect(entitlementsForPlan(plan), String(plan)).toEqual(FREE_ENTITLEMENTS)
    }
    expect(FREE_ENTITLEMENTS.plan).toBe('free')
  })

  it('does not resolve inherited object keys as plans', () => {
    for (const plan of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(entitlementsForPlan(plan), plan).toEqual(FREE_ENTITLEMENTS)
    }
  })

  it('returns a copy, so a caller cannot change a tier for everyone', () => {
    const a = entitlementsForPlan('pro')
    a.maxSyncTargets = 9_999
    expect(entitlementsForPlan('pro').maxSyncTargets).toBe(25)
    expect(PLAN_ENTITLEMENTS.pro.maxSyncTargets).toBe(25)
  })
})

describe('the legacy per-feature tables are derived from the single tier table', () => {
  it('sync limits match entitlements on every plan', () => {
    for (const [plan, e] of Object.entries(PLAN_ENTITLEMENTS)) {
      expect(syncLimitsForPlan(plan), plan).toEqual({ maxSyncTargets: e.maxSyncTargets, autoRunsPerHour: e.autoRunsPerHour })
    }
    expect(Object.keys(SYNC_PLAN_LIMITS).sort()).toEqual(Object.keys(PLAN_ENTITLEMENTS).sort())
    expect(FREE_SYNC_LIMITS).toEqual({ maxSyncTargets: FREE_PLAN_MAX_SYNC_TARGETS, autoRunsPerHour: 60 })
  })

  it('audit retention and compliance export match entitlements on every plan', () => {
    for (const [plan, e] of Object.entries(PLAN_ENTITLEMENTS)) {
      expect(AUDIT_RETENTION_DAYS[plan], plan).toBe(e.auditRetentionDays)
      expect(COMPLIANCE_EXPORT_PLANS.has(plan), plan).toBe(e.complianceExport)
    }
    expect(DEFAULT_RETENTION_DAYS).toBe(7)
    expect(AUDIT_RETENTION_DAYS).toEqual({ free: 7, pro: 90, team: 365, enterprise: -1 })
    expect([...COMPLIANCE_EXPORT_PLANS].sort()).toEqual(['enterprise', 'team'])
  })
})

describe('loadEntitlements', () => {
  it('reads the organisation plan from D1', async () => {
    const env = createTestEnv()
    const { orgId } = await seedUser(env)
    expect(await loadEntitlements(env as never, orgId)).toEqual(FREE_ENTITLEMENTS)
    await env.DB.prepare('UPDATE organisations SET plan = ? WHERE id = ?').bind('pro', orgId).run()
    expect(await loadEntitlements(env as never, orgId)).toEqual(entitlementsForPlan('pro'))
  })

  it('falls back to free for a missing organisation', async () => {
    const env = createTestEnv()
    expect(await loadEntitlements(env as never, 'org_does_not_exist')).toEqual(FREE_ENTITLEMENTS)
  })
})
