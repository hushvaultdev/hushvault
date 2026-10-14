import { apiFetch, apiFetchEnvelope } from './api'
import type { OrgDetail, OrgListPage, OrgSummary } from './types'

// Typed client for /api/admin. Every function here maps 1:1 to a route in apps/api/src/routes/admin.ts.
// No function ever receives or returns a secret value, a credential, or another tenant's project/secret
// contents — only plan, entitlements and usage counts.

const BASE = '/api/admin'

// GET /api/admin/orgs returns { data: OrgSummary[], nextCursor }, not the plain { data } envelope
// apiFetch unwraps elsewhere — apiFetchEnvelope keeps the cursor alongside the page.
export async function listOrgs(cursor?: string | null): Promise<OrgListPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return apiFetchEnvelope<OrgListPage>(`${BASE}/orgs${qs}`)
}

export function getOrg(id: string): Promise<OrgDetail> {
  return apiFetch<OrgDetail>(`${BASE}/orgs/${encodeURIComponent(id)}`)
}

export function setPlan(id: string, plan: string): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return apiFetch(`${BASE}/orgs/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: { plan } })
}

export function grantComp(id: string, plan: string, days: number): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return apiFetch(`${BASE}/orgs/${encodeURIComponent(id)}/comp`, { method: 'POST', body: { plan, days } })
}

export function revokeComp(id: string): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return apiFetch(`${BASE}/orgs/${encodeURIComponent(id)}/comp`, { method: 'DELETE' })
}

// Re-exported so callers that only need the row type don't have to import from ./types directly.
export type { OrgSummary }
