// Single source of truth for which integrations exist and how far along they are (issue #38).
// Dashboard cards, marketing copy and the README status block derive from this registry, and
// tests fail when public copy claims a non-`available` integration works, or when an entry is
// promoted without a provider module, a test file and a docs page. No imports: consumed by the
// web app as source and by tests.

export type IntegrationStatus = 'planned' | 'beta' | 'available'
export type IntegrationDirection = 'push' | 'pull' | 'notify'

export interface IntegrationInfo {
  id: string
  name: string
  /** Two-letter mark for the dashboard card. */
  mark: string
  status: IntegrationStatus
  directions: readonly IntegrationDirection[]
  /** One honest sentence. For anything not `available` it must read as a plan, not a feature. */
  summary: string
  /** Tracking issue in hushvaultdev/hushvault. */
  issue: number
}

export const INTEGRATIONS: readonly IntegrationInfo[] = [
  {
    id: 'cloudflare-workers',
    name: 'Cloudflare Workers',
    mark: 'CW',
    status: 'beta',
    directions: ['push'],
    summary: 'Beta: push an environment to a Cloudflare Worker one way, Worker secrets only (API only, manual runs).',
    issue: 41,
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    mark: 'GH',
    status: 'planned',
    directions: ['pull', 'push'],
    summary: 'Planned: pull secrets into workflows without a stored GitHub credential, and later push to GitHub secrets.',
    issue: 43,
  },
  {
    id: 'cloudflare-pages',
    name: 'Cloudflare Pages',
    mark: 'CF',
    status: 'planned',
    directions: ['push'],
    summary: 'Planned, lowest priority: sync secrets to Cloudflare Pages environment variables.',
    issue: 45,
  },
  {
    id: 'slack',
    name: 'Slack',
    mark: 'SL',
    status: 'planned',
    directions: ['notify'],
    summary: 'Planned: alerts for expiring secrets and failed syncs.',
    issue: 37,
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    mark: 'WH',
    status: 'planned',
    directions: ['notify'],
    summary: 'Planned: signed event payloads delivered to your endpoints on secret changes.',
    issue: 37,
  },
]

export function integrationsWithStatus(status: IntegrationStatus): IntegrationInfo[] {
  return INTEGRATIONS.filter((i) => i.status === status)
}

/** "A, B and C" over the integrations that are not available yet, for copy that must stay honest. */
export function plannedNamesPhrase(): string {
  const names = INTEGRATIONS.filter((i) => i.status !== 'available').map((i) => i.name)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Files a provider must have before it may be marked beta or available. */
export function promotionEvidence(id: string): { provider: string; test: string; docs: string } {
  return {
    provider: `apps/api/src/integrations/providers/${id}.ts`,
    test: `apps/api/test/integrations-${id}.test.ts`,
    docs: `docs/integrations/${id}.md`,
  }
}

// ---------------------------------------------------------------------------------------------
// API contract for sync targets and runs (issues #40, #41). Names only: no endpoint ever carries a
// secret value or a provider credential. All timestamps are ISO strings.
// ---------------------------------------------------------------------------------------------

export type SyncRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'
export type SyncTrigger = 'manual' | 'change' | 'schedule'
export type SyncErrorCode =
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_VALIDATION'
  | 'PROVIDER_ERROR'
  | 'TARGET_NOT_FOUND'
  | 'COMPUTED_ERROR'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'TIMEOUT'

export interface SyncNameFilter {
  /** Only names starting with this prefix are pushed (the prefix is kept in the target name). */
  prefix?: string
  /** Names that are never pushed (local-only). */
  deny?: string[]
}

export interface SyncTargetDto {
  id: string
  projectId: string
  envId: string
  connectionId: string
  provider: string
  /** Provider-specific identifiers only, e.g. { accountId, scriptName } for Cloudflare Workers. */
  resource: Record<string, string>
  nameFilter: SyncNameFilter
  /** When true, names HushVault created that no longer exist in the environment are deleted on the target. */
  deleteRemoved: boolean
  status: 'active' | 'needs_attention'
  lastRunAt: string | null
  lastRunStatus: SyncRunStatus | null
  createdAt: string
  updatedAt: string
}

/** Names grouped by what a run would do. Never values. */
export interface SyncPlanDto {
  create: string[]
  update: string[]
  delete: string[]
  skip: string[]
  /** Target already has this name and HushVault never created it: left untouched. */
  conflict: string[]
  /** Reasons a run cannot start (e.g. over the provider's limits). Empty when the plan is runnable. */
  blockers: { code: SyncErrorCode | 'TOO_MANY_ITEMS' | 'VALUE_TOO_LARGE' | 'NAME_INVALID'; names: string[] }[]
}

export interface SyncRunDto {
  id: string
  targetId: string
  trigger: SyncTrigger
  status: SyncRunStatus
  attempt: number
  counts: { created: number; updated: number; deleted: number; skipped: number; failed: number }
  errorCode: SyncErrorCode | null
  startedAt: string
  finishedAt: string | null
  nextRetryAt: string | null
}

/**
 * Endpoints (all under /api/integrations, JWT-only, admin+, membership re-read; run and preview are rate limited):
 *   POST   /targets                 body { projectId, envId, connectionId, resource, nameFilter?, deleteRemoved? } -> 201 { data: SyncTargetDto }
 *   GET    /targets                 -> { data: SyncTargetDto[] }
 *   PATCH  /targets/:id             body { resource?, nameFilter?, deleteRemoved? } (the connection cannot be changed) -> { data: SyncTargetDto }
 *   DELETE /targets/:id             -> { data: { deleted: true } }
 *   POST   /targets/:id/preview     -> { data: SyncPlanDto }
 *   POST   /targets/:id/run         -> { data: SyncRunDto }   (a plan with blockers is a 422 SYNC_BLOCKED carrying { plan })
 *   GET    /targets/:id/runs        -> { data: SyncRunDto[] } newest first, max 50
 *   GET    /runs/:runId             -> { data: SyncRunDto }
 * Errors: standard { error, message }. Free plan: at most 2 targets per organisation (409 PLAN_LIMIT).
 */
export const FREE_PLAN_MAX_SYNC_TARGETS = 2
