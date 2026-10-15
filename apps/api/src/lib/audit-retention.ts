import type { Env } from '../index'
import { FREE_ENTITLEMENTS, PLAN_ENTITLEMENTS } from './entitlements'

// Per-plan audit log retention, in days. -1 = retain forever (never purge, never truncate queries).
// Derived from the single tier table in entitlements.ts.
// Fallback when an org's plan string isn't recognised (treat as the most restrictive tier).
export const DEFAULT_RETENTION_DAYS = FREE_ENTITLEMENTS.auditRetentionDays

export const AUDIT_RETENTION_DAYS: Record<string, number> = Object.fromEntries(
  Object.entries(PLAN_ENTITLEMENTS).map(([plan, e]) => [plan, e.auditRetentionDays]),
)

// Plans that may export the audit log (compliance evidence).
export const COMPLIANCE_EXPORT_PLANS = new Set<string>(
  Object.entries(PLAN_ENTITLEMENTS).filter(([, e]) => e.complianceExport).map(([plan]) => plan),
)

export type OrgRetentionSettings = {
  plan: string
  auditRetentionDays: number | null
}

// Resolve the effective retention window for an org. An explicit per-org
// override (audit_retention_days) takes precedence over the plan default, but
// can never exceed the plan's allowance (you can shorten retention, not extend
// past your tier). Returns -1 for "retain forever".
export function effectiveRetentionDays(settings: OrgRetentionSettings): number {
  const planDays = AUDIT_RETENTION_DAYS[settings.plan] ?? DEFAULT_RETENTION_DAYS
  const override = settings.auditRetentionDays
  if (override == null || override <= 0) return planDays
  if (planDays === -1) return override
  return Math.min(override, planDays)
}

// ISO timestamp cutoff for a retention window, or null when retention is
// unlimited. Rows with `timestamp <= cutoff` are outside the window.
export function retentionCutoffIso(retentionDays: number, now: Date = new Date()): string | null {
  if (retentionDays === -1) return null
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - retentionDays)
  return cutoff.toISOString()
}

// Load the retention-relevant settings for an org from D1.
export async function loadOrgRetention(env: Env, orgId: string): Promise<OrgRetentionSettings | null> {
  const row = await env.DB.prepare(
    'SELECT plan, audit_retention_days FROM organisations WHERE id = ? LIMIT 1',
  )
    .bind(orgId)
    .first<{ plan: string; audit_retention_days: number | null }>()

  if (!row) return null
  return { plan: row.plan, auditRetentionDays: row.audit_retention_days ?? null }
}

// Whether the org's plan permits compliance export.
export function canComplianceExport(plan: string): boolean {
  return COMPLIANCE_EXPORT_PLANS.has(plan)
}
