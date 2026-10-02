import type { SyncNameFilter, SyncPlanDto, SyncRunDto, SyncTargetDto } from '@hushvault/shared/integrations'

import { apiFetch } from './api'

// Typed client for /api/integrations. No function here ever receives a secret value; the only
// credential-bearing calls are createConnection and rotateCredential, which send it once and
// never keep or return it.

export interface ProviderDto {
  id: string
  name: string
  status: 'planned' | 'beta' | 'available'
  directions: string[]
  summary: string
  /** True only for providers implemented in this deployment. */
  connectable: boolean
}

export interface ConnectionDto {
  id: string
  provider: string
  label: string
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastVerifiedAt: string | null
}

const BASE = '/api/integrations'

export function listProviders(): Promise<ProviderDto[]> {
  return apiFetch<ProviderDto[]>(`${BASE}/providers`)
}

export function listConnections(): Promise<ConnectionDto[]> {
  return apiFetch<ConnectionDto[]>(`${BASE}/connections`)
}

export function createConnection(input: {
  provider: string
  label: string
  credential: string
  config: Record<string, unknown>
}): Promise<ConnectionDto> {
  return apiFetch<ConnectionDto>(`${BASE}/connections`, { method: 'POST', body: input })
}

export function rotateCredential(id: string, credential: string): Promise<ConnectionDto> {
  return apiFetch<ConnectionDto>(`${BASE}/connections/${encodeURIComponent(id)}/credential`, {
    method: 'PUT',
    body: { credential },
  })
}

export function revokeConnection(id: string): Promise<unknown> {
  return apiFetch<unknown>(`${BASE}/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listTargets(): Promise<SyncTargetDto[]> {
  return apiFetch<SyncTargetDto[]>(`${BASE}/targets`)
}

export function createTarget(input: {
  projectId: string
  envId: string
  connectionId: string
  resource: Record<string, string>
  nameFilter?: SyncNameFilter
  deleteRemoved?: boolean
}): Promise<SyncTargetDto> {
  return apiFetch<SyncTargetDto>(`${BASE}/targets`, { method: 'POST', body: input })
}

export function updateTarget(
  id: string,
  input: { resource?: Record<string, string>; nameFilter?: SyncNameFilter; deleteRemoved?: boolean },
): Promise<SyncTargetDto> {
  return apiFetch<SyncTargetDto>(`${BASE}/targets/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })
}

export function deleteTarget(id: string): Promise<unknown> {
  return apiFetch<unknown>(`${BASE}/targets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function previewTarget(id: string): Promise<SyncPlanDto> {
  return apiFetch<SyncPlanDto>(`${BASE}/targets/${encodeURIComponent(id)}/preview`, { method: 'POST' })
}

export function runTarget(id: string): Promise<SyncRunDto> {
  return apiFetch<SyncRunDto>(`${BASE}/targets/${encodeURIComponent(id)}/run`, { method: 'POST' })
}

export function listRuns(targetId: string): Promise<SyncRunDto[]> {
  return apiFetch<SyncRunDto[]>(`${BASE}/targets/${encodeURIComponent(targetId)}/runs`)
}
