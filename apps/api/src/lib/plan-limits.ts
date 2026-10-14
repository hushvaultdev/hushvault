import type { Env } from '../index'
import { FREE_ENTITLEMENTS, PLAN_ENTITLEMENTS } from './entitlements'

// A count can never reach this, so it stands in for "unlimited" where SQL needs a number.
const UNLIMITED_SENTINEL = 2_147_483_647

// Per-plan sync limits, derived from the single tier table in entitlements.ts.
//
// WHY NOT A SELF-SERVE UPGRADE ENDPOINT. Billing is not live (the pricing page
// says so). An API that let an owner set their own plan to a paid tier would be
// granting paid limits for free, so there is deliberately no such route. An
// operator raises a client's plan directly in D1 — see docs/OPERATIONS.md
// "Setting an organisation's plan". The caps below are read wherever a sync
// limit is enforced, so once the plan column is set the limits lift with no code
// change. (-1 = unlimited.)

export type SyncPlanLimits = {
  /** Max active sync targets per organisation. -1 = unlimited. */
  maxSyncTargets: number
  /** Automatic runs (change + schedule + retry) per organisation per hour. -1 = unlimited. */
  autoRunsPerHour: number
}

const toSyncLimits = (e: { maxSyncTargets: number; autoRunsPerHour: number }): SyncPlanLimits => ({
  maxSyncTargets: e.maxSyncTargets,
  autoRunsPerHour: e.autoRunsPerHour,
})

// The most restrictive tier; also the fallback for an unrecognised plan.
export const FREE_SYNC_LIMITS: SyncPlanLimits = toSyncLimits(FREE_ENTITLEMENTS)

export const SYNC_PLAN_LIMITS: Record<string, SyncPlanLimits> = Object.fromEntries(
  Object.entries(PLAN_ENTITLEMENTS).map(([plan, e]) => [plan, toSyncLimits(e)]),
)

export function syncLimitsForPlan(plan: string | null | undefined): SyncPlanLimits {
  return (plan && SYNC_PLAN_LIMITS[plan]) || FREE_SYNC_LIMITS
}

/** Load an org's plan and resolve its sync limits in one read. Falls back to the free tier. */
export async function loadSyncLimits(env: Env, orgId: string): Promise<SyncPlanLimits> {
  const row = await env.DB.prepare('SELECT plan FROM organisations WHERE id = ? LIMIT 1')
    .bind(orgId).first<{ plan: string }>()
  return syncLimitsForPlan(row?.plan)
}

/** True when `count` is within the limit. A negative limit (-1) is unlimited. */
export function withinLimit(count: number, limit: number): boolean {
  return limit < 0 || count < limit
}

/**
 * A SQL `CASE` expression mapping an org's plan to its max-sync-targets cap, built from
 * SYNC_PLAN_LIMITS so the tiers have one source. `planSelect` is a fixed sub-SELECT that yields the
 * plan string (e.g. "SELECT plan FROM organisations WHERE id = ?"); it and the plan keys are server
 * constants, never caller input, so interpolating them is allowed (see .claude/rules/database-schema.md).
 * Unlimited tiers map to a sentinel a real count can never reach; an unknown plan maps to the free cap.
 */
export function maxSyncTargetsCaseSql(planSelect: string): string {
  const whens = Object.entries(SYNC_PLAN_LIMITS)
    .map(([plan, l]) => `WHEN '${plan}' THEN ${l.maxSyncTargets < 0 ? UNLIMITED_SENTINEL : l.maxSyncTargets}`)
    .join(' ')
  const free = FREE_SYNC_LIMITS.maxSyncTargets < 0 ? UNLIMITED_SENTINEL : FREE_SYNC_LIMITS.maxSyncTargets
  return `CASE (${planSelect}) ${whens} ELSE ${free} END`
}
