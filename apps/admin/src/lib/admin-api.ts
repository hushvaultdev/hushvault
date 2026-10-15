import { adminFetch, adminFetchEnvelope } from './api'
import type { OrgDetail, OrgListPage, OrgSummary } from './types'

const BASE = '/api/admin'

export async function listOrgs(cursor?: string | null): Promise<OrgListPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return adminFetchEnvelope<OrgListPage>(`${BASE}/orgs${qs}`)
}

export function getOrg(id: string): Promise<OrgDetail> {
  return adminFetch<OrgDetail>(`${BASE}/orgs/${encodeURIComponent(id)}`)
}

export function setPlan(id: string, plan: string): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return adminFetch(`${BASE}/orgs/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: { plan } })
}

export function grantComp(id: string, plan: string, days: number): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return adminFetch(`${BASE}/orgs/${encodeURIComponent(id)}/comp`, { method: 'POST', body: { plan, days } })
}

export function revokeComp(id: string): Promise<{ id: string; plan: string; planExpiresAt: string | null }> {
  return adminFetch(`${BASE}/orgs/${encodeURIComponent(id)}/comp`, { method: 'DELETE' })
}

export type { OrgSummary }
