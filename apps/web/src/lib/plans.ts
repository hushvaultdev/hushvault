// Canonical plan definitions shared by the marketing pricing page and the
// in-product billing page, so the tiers don't drift between them.
//
// IMPORTANT: hosted billing (Stripe) and plan-limit enforcement are not built
// yet. Only the self-hosted Free tier is available today; every other tier is
// a planned offering and its prices are provisional. Features that are not
// implemented are suffixed with "(planned)" so they are never presented as
// shipped.

export type PlanName = 'Free' | 'Pro' | 'Team' | 'Enterprise'

export type PlanStatus = 'available' | 'planned'

export interface PlanDefinition {
  name: PlanName
  price: string
  status: PlanStatus
  audience: string
  features: string[]
}

export const PLANS: PlanDefinition[] = [
  {
    name: 'Free',
    price: '$0',
    status: 'available',
    audience: 'Solo developers and early projects. Self-host on the Cloudflare free tier.',
    features: [
      'Computed secrets',
      'Branch inheritance',
      'Share links (API)',
      'Cloudflare Pages sync (planned)',
      'GitHub Actions sync (planned)',
    ],
  },
  {
    name: 'Pro',
    price: '$12/mo',
    status: 'planned',
    audience: 'Active teams that want better operational control.',
    features: [
      'Unlimited projects (planned)',
      'Higher secret limits (planned)',
      'Drift detection (planned)',
      'Slack alerts (planned)',
      'Extended audit history (planned)',
    ],
  },
  {
    name: 'Team',
    price: '$99/mo',
    status: 'planned',
    audience: 'Startups that need governance and shared infrastructure.',
    features: [
      'Role-based access control',
      'SSO (planned)',
      'Audit log export (API)',
      'Custom domain (planned)',
      'Full audit retention (planned)',
      'Priority support (planned)',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    status: 'planned',
    audience: 'Organisations with advanced security and scale needs.',
    features: [
      'Self-host at $0',
      'Dedicated support (planned)',
      'Custom SLAs (planned)',
      'Security review assistance (planned)',
      'Volume pricing (planned)',
    ],
  },
]
