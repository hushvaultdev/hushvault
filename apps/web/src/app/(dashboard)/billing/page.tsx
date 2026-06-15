'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/lib/auth-context'

import styles from './billing.module.css'

const s = (name: string) => styles[name]

// No API exists yet to fetch the org's live plan/usage, so the billing page is
// rendered from static plan definitions and every workspace is shown on Free.
const CURRENT_PLAN = 'Free'

type UsageStat = {
  label: string
  value: number
  limit: number
  unit?: string
}

// Illustrative placeholders — not wired to real usage data yet.
const usage: UsageStat[] = [
  { label: 'Projects', value: 2, limit: 3 },
  { label: 'Secrets', value: 48, limit: 100 },
  { label: 'Team members', value: 1, limit: 3 },
]

type Plan = {
  name: string
  price: string
  audience: string
  features: string[]
  tone: 'light' | 'dark'
}

const plans: Plan[] = [
  {
    name: 'Free',
    price: '$0',
    audience: 'Solo developers and early projects.',
    features: [
      'Computed secrets',
      'Branch inheritance',
      'Share links',
      'Cloudflare Pages sync',
      'GitHub Actions sync',
    ],
    tone: 'light',
  },
  {
    name: 'Pro',
    price: '$12/mo',
    audience: 'Active teams that want better operational control.',
    features: [
      'Unlimited projects',
      'Higher secret limits',
      'Drift detection',
      'Slack alerts',
      'Extended audit history',
    ],
    tone: 'light',
  },
  {
    name: 'Team',
    price: '$99/mo',
    audience: 'Startups that need governance and shared infrastructure.',
    features: [
      'RBAC and SSO',
      'Compliance export',
      'Custom domain',
      'Full audit retention',
      'Priority support',
    ],
    tone: 'dark',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    audience: 'Organisations with advanced security and scale needs.',
    features: [
      'Self-host at $0',
      'Dedicated support',
      'Custom SLAs',
      'Security review assistance',
      'Volume pricing',
    ],
    tone: 'light',
  },
]

function clampPercent(value: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(100, Math.round((value / limit) * 100))
}

export default function BillingPage() {
  const { session } = useAuth()
  const workspace = session?.orgId ?? 'Unknown workspace'

  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Billing</h1>
        <p className={s('pageSubtitle')}>Review your plan and see what each tier unlocks as your team grows.</p>
      </div>

      <Card className={s('summaryCard')} tone="light">
        <div className={s('summaryHeader')}>
          <h2 className={s('summaryTitle')}>Current plan</h2>
          <Badge tone="success">{CURRENT_PLAN}</Badge>
        </div>
        <div className={s('summaryMeta')}>
          <span className={s('summaryWorkspace')}>Workspace: {workspace}</span>
          <span className={s('pageSubtitle')}>
            You are on the {CURRENT_PLAN} plan at $0 — full self-host included.
          </span>
        </div>
        <p className={s('summaryNote')}>Live plan and usage data is coming soon. The figures below are illustrative.</p>
      </Card>

      <div className={s('sectionBlock')}>
        <h2 className={s('sectionTitle')}>Usage (illustrative)</h2>
        <div className={s('usageGrid')}>
          {usage.map((stat) => (
            <Card key={stat.label} className={s('usageCard')} tone="light">
              <p className={s('usageLabel')}>{stat.label}</p>
              <div className={s('usageValue')}>
                {stat.value}
                <span>
                  {' / '}
                  {stat.limit}
                  {stat.unit ? ` ${stat.unit}` : ''}
                </span>
              </div>
              <div className={s('meter')}>
                <div className={s('meterFill')} style={{ width: `${clampPercent(stat.value, stat.limit)}%` }} />
              </div>
              <p className={s('usageHint')}>Placeholder figure — not yet connected to live usage.</p>
            </Card>
          ))}
        </div>
      </div>

      <div className={s('sectionBlock')}>
        <h2 className={s('sectionTitle')}>Plans</h2>
        <div className={s('plansGrid')}>
          {plans.map((plan) => {
            const isCurrent = plan.name === CURRENT_PLAN
            return (
              <Card key={plan.name} className={s('planCard')} tone={plan.tone}>
                <div className={s('planHeader')}>
                  <span className={s('planName')}>{plan.name}</span>
                  <span className={s('planPrice')}>{plan.price}</span>
                </div>
                {isCurrent ? <Badge tone="accent">Current plan</Badge> : <Badge tone="neutral">Available</Badge>}
                <p className={s('planAudience')}>{plan.audience}</p>
                <ul className={s('planFeatures')}>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <div className={s('planAction')}>
                  {isCurrent ? (
                    <Button type="button" variant="secondary" disabled>
                      Current plan
                    </Button>
                  ) : (
                    <>
                      <Button href="#" variant={plan.tone === 'dark' ? 'secondary' : 'primary'}>
                        Upgrade
                      </Button>
                      <p className={s('upgradeHint')}>Checkout is not yet active.</p>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
