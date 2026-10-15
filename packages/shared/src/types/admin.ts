// DTOs for the platform admin surface (issue #103/#108). Consumed via the raw-TypeScript
// '@hushvault/shared/types' subpath (see package.json) so apps/admin resolves it the same way
// apps/web resolves '@hushvault/shared/integrations' — transpiled, no build-before-typecheck step.
//
// These mirror apps/api/src/routes/admin.ts's actual response shapes and apps/api/src/lib/
// entitlements.ts's Entitlements/PlanTier. The admin app never receives a secret value or another
// tenant's project/secret contents through these — only plan, usage counts and membership counts.

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise'

export interface OrgSummary {
  id: string
  name: string
  slug: string
  plan: PlanTier
  planExpiresAt: string | null
  memberCount: number
  createdAt: string
}

export interface Entitlements {
  plan: PlanTier
  maxSyncTargets: number
  autoRunsPerHour: number
  auditRetentionDays: number
  complianceExport: boolean
  // -1 means unlimited/undecided (see apps/api/src/lib/entitlements.ts).
  maxProjects: number
  maxSecrets: number
  maxEnvironmentsPerProject: number
  maxSeats: number
}

export interface OrgDetail extends OrgSummary {
  entitlements: Entitlements
  usage: { projectCount: number; syncTargetCount: number }
}

/** GET /api/admin/orgs's envelope: the `{ data }` shape plus a opaque keyset cursor. */
export interface OrgListPage {
  data: OrgSummary[]
  nextCursor: string | null
}
