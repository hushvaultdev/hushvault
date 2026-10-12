import { describe, expect, it } from 'vitest'
import { FREE_PLAN_MAX_SYNC_TARGETS } from '@hushvault/shared/integrations'
import {
  FREE_SYNC_LIMITS,
  SYNC_PLAN_LIMITS,
  maxSyncTargetsCaseSql,
  syncLimitsForPlan,
  withinLimit,
} from '../src/lib/plan-limits'

describe('syncLimitsForPlan', () => {
  it('maps each known plan to its tier', () => {
    expect(syncLimitsForPlan('free')).toEqual(FREE_SYNC_LIMITS)
    expect(syncLimitsForPlan('pro').maxSyncTargets).toBe(25)
    expect(syncLimitsForPlan('team').maxSyncTargets).toBe(100)
    expect(syncLimitsForPlan('enterprise').maxSyncTargets).toBe(-1)
  })

  it('falls back to the free tier for unknown, null or undefined plans (fails closed)', () => {
    expect(syncLimitsForPlan('nope')).toEqual(FREE_SYNC_LIMITS)
    expect(syncLimitsForPlan(null)).toEqual(FREE_SYNC_LIMITS)
    expect(syncLimitsForPlan(undefined)).toEqual(FREE_SYNC_LIMITS)
  })

  it('anchors the free cap to the shared constant so they never drift', () => {
    expect(FREE_SYNC_LIMITS.maxSyncTargets).toBe(FREE_PLAN_MAX_SYNC_TARGETS)
  })
})

describe('withinLimit', () => {
  it('treats a negative limit as unlimited', () => {
    expect(withinLimit(1_000_000, -1)).toBe(true)
  })
  it('allows up to but not including the limit', () => {
    expect(withinLimit(1, 2)).toBe(true)
    expect(withinLimit(2, 2)).toBe(false)
  })
})

describe('maxSyncTargetsCaseSql', () => {
  it('emits a CASE over every plan with the unlimited sentinel for enterprise and the free fallback', () => {
    const sql = maxSyncTargetsCaseSql('SELECT plan FROM organisations WHERE id = ?')
    expect(sql).toContain("WHEN 'free' THEN 2")
    expect(sql).toContain("WHEN 'pro' THEN 25")
    expect(sql).toContain("WHEN 'team' THEN 100")
    // enterprise is unlimited -> sentinel a real count can never reach
    expect(sql).toContain("WHEN 'enterprise' THEN 2147483647")
    // every known plan is represented
    for (const plan of Object.keys(SYNC_PLAN_LIMITS)) expect(sql).toContain(`WHEN '${plan}'`)
    // unknown plan falls through to the free cap
    expect(sql).toMatch(/ELSE 2 END$/)
  })
})
