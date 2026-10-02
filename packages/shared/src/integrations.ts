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
    status: 'planned',
    directions: ['push'],
    summary: 'Planned: push resolved secrets to a Cloudflare Worker as Worker secrets.',
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
