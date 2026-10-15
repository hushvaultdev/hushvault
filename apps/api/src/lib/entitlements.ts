import { FREE_PLAN_MAX_SYNC_TARGETS } from '@hushvault/shared/integrations'
import type { Env } from '../index'

// The single table of what each plan allows. Feature modules read their limits from here (plan-limits.ts and
// audit-retention.ts derive their maps from it) instead of switching on the raw plan string, so a tier is changed
// in one place. -1 means unlimited. Billing is not built: an organisation's plan is only ever set by an operator
// (docs/OPERATIONS.md "Setting an organisation's plan"), never by the organisation itself.

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise'

export type Entitlements = {
  /** The tier these limits belong to. An unrecognised plan resolves to 'free'. */
  plan: PlanTier
  /** Max active sync targets per organisation. */
  maxSyncTargets: number
  /** Automatic runs (change + schedule + retry) per organisation per hour. */
  autoRunsPerHour: number
  /** Audit log retention in days. */
  auditRetentionDays: number
  /** May export the audit log as compliance evidence. */
  complianceExport: boolean
  // No numbers are decided for these yet: unlimited placeholders until the comp-license market test (#104) sets them.
  // Nothing enforces them today; they exist so a route can check entitlements and a cap is a one-line change later.
  maxProjects: number
  maxSecrets: number
  maxEnvironmentsPerProject: number
  maxSeats: number
}

const UNDECIDED = { maxProjects: -1, maxSecrets: -1, maxEnvironmentsPerProject: -1, maxSeats: -1 } as const

export const PLAN_ENTITLEMENTS: Record<PlanTier, Entitlements> = {
  free: { plan: 'free', maxSyncTargets: FREE_PLAN_MAX_SYNC_TARGETS, autoRunsPerHour: 60, auditRetentionDays: 7, complianceExport: false, ...UNDECIDED },
  pro: { plan: 'pro', maxSyncTargets: 25, autoRunsPerHour: 600, auditRetentionDays: 90, complianceExport: false, ...UNDECIDED },
  team: { plan: 'team', maxSyncTargets: 100, autoRunsPerHour: 2_000, auditRetentionDays: 365, complianceExport: true, ...UNDECIDED },
  enterprise: { plan: 'enterprise', maxSyncTargets: -1, autoRunsPerHour: -1, auditRetentionDays: -1, complianceExport: true, ...UNDECIDED },
}

// The most restrictive tier; also the fallback for an unrecognised plan, so a bad value fails closed.
export const FREE_ENTITLEMENTS: Entitlements = PLAN_ENTITLEMENTS.free

/** Resolve a plan string to its limits. Unknown, null or inherited-key values fall back to the free tier. Returns a copy. */
export function entitlementsForPlan(plan: string | null | undefined): Entitlements {
  const known = typeof plan === 'string' && Object.hasOwn(PLAN_ENTITLEMENTS, plan) ? PLAN_ENTITLEMENTS[plan as PlanTier] : FREE_ENTITLEMENTS
  return { ...known }
}

/** Load an organisation's plan and resolve its entitlements in one read. A missing organisation resolves to free. */
export async function loadEntitlements(env: Env, orgId: string): Promise<Entitlements> {
  const row = await env.DB.prepare('SELECT plan FROM organisations WHERE id = ? LIMIT 1')
    .bind(orgId).first<{ plan: string }>()
  return entitlementsForPlan(row?.plan)
}
