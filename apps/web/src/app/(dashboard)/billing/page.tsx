'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/lib/auth-context'
import { PLANS, type PlanName } from '@/lib/plans'

import styles from './billing.module.css'

const s = (name: string) => styles[name]

// Stripe billing and plan-limit enforcement are not implemented, and no API
// exists to fetch an org's live plan/usage, so every workspace is shown on Free.
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

// Presentation-only tone per plan; the plan data itself comes from the shared
// PLANS module (also used by the marketing pricing page) to avoid drift.
const PLAN_TONE: Record<PlanName, 'light' | 'dark'> = {
  Free: 'light',
  Pro: 'light',
  Team: 'dark',
  Enterprise: 'light',
}

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
        <p className={s('pageSubtitle')}>Hosted billing is not available yet. Below is a preview of the planned tiers.</p>
      </div>

      <Card className={s('summaryCard')} tone="light">
        <div className={s('summaryHeader')}>
          <h2 className={s('summaryTitle')}>Current plan</h2>
          <Badge tone="success">{CURRENT_PLAN}</Badge>
        </div>
        <div className={s('summaryMeta')}>
          <span className={s('summaryWorkspace')}>Workspace: {workspace}</span>
          <span className={s('pageSubtitle')}>
            You are on the {CURRENT_PLAN} plan at $0. Plan limits (projects, secrets, members) are not enforced yet.
          </span>
        </div>
        <p className={s('summaryNote')}>Live plan and usage data is coming soon. The usage figures below are examples, not your real usage.</p>
      </Card>

      <div className={s('sectionBlock')}>
        <h2 className={s('sectionTitle')}>Usage (example data)</h2>
        <div className={s('usageGrid')}>
          {usage.map((stat) => {
            const percent = clampPercent(stat.value, stat.limit)
            return (
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
                <div
                  className={s('meter')}
                  role="progressbar"
                  aria-label={`${stat.label} usage`}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={s('meterFill')} style={{ width: `${percent}%` }} />
                </div>
                <p className={s('usageHint')}>Example figure. Not your real usage.</p>
              </Card>
            )
          })}
        </div>
      </div>

      <div className={s('sectionBlock')}>
        <h2 className={s('sectionTitle')}>Plans</h2>
        <div className={s('plansGrid')}>
          {PLANS.map((plan) => {
            const isCurrent = plan.name === CURRENT_PLAN
            const tone = PLAN_TONE[plan.name]
            const cardClass = `${s('planCard')} ${tone === 'dark' ? s('planCardDark') : ''}`.trim()
            return (
              <Card key={plan.name} className={cardClass} tone={tone}>
                <div className={s('planHeader')}>
                  <span className={s('planName')}>{plan.name}</span>
                  <span className={s('planPrice')}>{plan.price}</span>
                </div>
                {isCurrent ? <Badge tone="accent">Current plan</Badge> : <Badge tone="neutral">Planned</Badge>}
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
                      <Button type="button" variant={tone === 'dark' ? 'secondary' : 'primary'} disabled>
                        Coming soon
                      </Button>
                      <p className={s('upgradeHint')}>Checkout is not available yet.</p>
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
