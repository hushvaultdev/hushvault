// Audit-export entitlement, as the dashboard sees it.
//
// `GET /api/audit/export` is gated on the Team/Enterprise plans and that gate stays (issue #92).
// Billing does not exist, so every organisation is on `free` forever and the endpoint answers
// 403 for every real caller. Rather than let the audit page turn that into an opaque error after
// the fact, `GET /api/audit/retention` reports the entitlement up front and the page explains it.
//
// Nothing here is an access check: the API enforces the gate itself. The worst a wrong answer
// here can do is show the wrong explanation.

/** Shape of `GET /api/audit/retention`'s `data`. `-1` days means unlimited. */
export type AuditRetention = {
  plan: string
  planMaxDays: number
  overrideDays: number | null
  effectiveDays: number
  // Server-derived from `canComplianceExport`. Optional on the wire because a web deploy can
  // run against an API that predates the field; a missing value is treated as "unknown" rather
  // than mirroring the plan list here, which would be a second copy of the rule to drift.
  complianceExport?: boolean
}

export type AuditExportState = 'available' | 'unavailable' | 'unknown'

export type AuditExportEntitlement = {
  state: AuditExportState
  /** The explanation shown next to the export area. Never empty. */
  note: string
}

// Deliberately names no upgrade path, waitlist or sales contact: there is none, and offering one
// would be a lie the product cannot honour. It says what is unavailable, why, and what works.
export const EXPORT_UNAVAILABLE_NOTE =
  'Audit log export is part of the Team plan. Hosted plans are not available yet, so no workspace can move off Free — export is unavailable for everyone until billing ships. Admins can read the full log on this page, or fetch it from the API with GET /api/audit.'

// The dashboard has never had a download control, so this state tells the truth about that too
// instead of promising a button that does not exist.
export const EXPORT_AVAILABLE_NOTE =
  'Audit log export is available on this organisation’s plan. The dashboard has no download button yet — call GET /api/audit/export?format=csv against the API to download the log.'

export const EXPORT_UNKNOWN_NOTE =
  'Export availability could not be checked, because this organisation’s plan details did not load. Admins can read the full log on this page, or fetch it from the API with GET /api/audit.'

/** What to tell the user about export, given the retention response (or null if it failed). */
export function auditExportEntitlement(retention: AuditRetention | null): AuditExportEntitlement {
  if (!retention || retention.complianceExport === undefined) {
    return { state: 'unknown', note: EXPORT_UNKNOWN_NOTE }
  }
  return retention.complianceExport
    ? { state: 'available', note: EXPORT_AVAILABLE_NOTE }
    : { state: 'unavailable', note: EXPORT_UNAVAILABLE_NOTE }
}

/** Plan ids are lowercase on the wire (`free`, `team`); render them as the UI names them. */
export function planLabel(plan: string): string {
  if (!plan) return 'Unknown'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}

/**
 * One sentence describing the window the log is actually kept for, or null when retention could
 * not be read. Distinguishes an organisation's own (shorter) override from the plan cap: the
 * first is a setting an admin chose, the second is not something anyone can lift today.
 */
export function retentionNote(retention: AuditRetention | null): string | null {
  if (!retention) return null
  if (retention.effectiveDays < 0) return 'Events are kept indefinitely on this plan.'

  const window = `${retention.effectiveDays} ${retention.effectiveDays === 1 ? 'day' : 'days'}`
  // Only credit the override when it is the value actually in force — a plan change can leave a
  // stale override that the plan cap clamps, and claiming it would misreport the cause.
  if (retention.overrideDays !== null && retention.overrideDays === retention.effectiveDays) {
    return `Events are kept for ${window}, from this organisation’s retention setting. Anything older is deleted.`
  }
  return `Events are kept for ${window} on the ${planLabel(retention.plan)} plan. Anything older is deleted.`
}
