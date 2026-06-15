// Canonical plan definitions shared by the marketing pricing page and the
// in-product billing page, so the freemium tiers don't drift between them.

export type PlanName = 'Free' | 'Pro' | 'Team' | 'Enterprise'

export interface PlanDefinition {
  name: PlanName
  price: string
  audience: string
  features: string[]
}

export const PLANS: PlanDefinition[] = [
  {
    name: 'Free',
    price: '$0',
    audience: 'Solo developers and early projects.',
    features: ['Computed secrets', 'Branch inheritance', 'Share links', 'Cloudflare Pages sync', 'GitHub Actions sync'],
  },
  {
    name: 'Pro',
    price: '$12/mo',
    audience: 'Active teams that want better operational control.',
    features: ['Unlimited projects', 'Higher secret limits', 'Drift detection', 'Slack alerts', 'Extended audit history'],
  },
  {
    name: 'Team',
    price: '$99/mo',
    audience: 'Startups that need governance and shared infrastructure.',
    features: ['RBAC and SSO', 'Compliance export', 'Custom domain', 'Full audit retention', 'Priority support'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    audience: 'Organisations with advanced security and scale needs.',
    features: ['Self-host at $0', 'Dedicated support', 'Custom SLAs', 'Security review assistance', 'Volume pricing'],
  },
]
