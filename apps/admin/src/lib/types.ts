// Shared admin DTOs now live in packages/shared (issue #108): the API routes, their response
// shapes and these types are kept in one place rather than duplicated per-app. Session stays
// admin-local — it is not shared with apps/web's richer Session (which also carries orgId/role).
export type { OrgSummary, Entitlements, OrgDetail, OrgListPage, PlanTier } from '@hushvault/shared/types'

export interface Session {
  token: string
  userId: string
}
