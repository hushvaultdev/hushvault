import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import { PLANS } from '@/lib/plans'

import styles from './page.module.css'

const s = (name: string) => styles[name]

// Presentation/CTA for the marketing surface; plan data comes from the shared
// PLANS module so the tiers stay in sync with the in-product billing page.
const MARKETING = {
  Free: { cta: 'Self-host for free', href: '/docs', tone: 'light' },
  Pro: { cta: 'Coming soon', href: null, tone: 'light' },
  Team: { cta: 'Coming soon', href: null, tone: 'dark' },
} as const

const plans = (Object.keys(MARKETING) as Array<keyof typeof MARKETING>).map((name) => {
  const def = PLANS.find((plan) => plan.name === name)
  if (!def) {
    throw new Error(`No plan definition found for "${name}" in PLANS`)
  }
  return { ...def, ...MARKETING[name] }
})

export default function PricingPage() {
  return (
    <main className={`page-shell ${s('pricingPage')}`}>
      <Section className={s('pricingHero')}>
        <div className="page-container">
          <span className="eyebrow">Pricing that matches your growth</span>
          <h1 className={s('pricingTitle')}>Own secrets now, upgrade only when the team needs it.</h1>
          <p className={s('pricingSubtitle')}>
            HushVault is free to self-host today. Hosted Pro and Team plans are planned: prices are provisional, billing is not live yet, and features marked &ldquo;planned&rdquo; are not available.
          </p>
        </div>
      </Section>

      <Section>
        <div className={`${s('plansGrid')} page-container`}>
          {plans.map((plan) => (
            <Card key={plan.name} className={s('planCard')} tone={plan.tone}>
              <div className={s('planHeader')}>
                <span className={s('planName')}>{plan.name}</span>
                <span className={s('planPrice')}>{plan.price}</span>
              </div>
              {plan.status === 'planned' ? <Badge tone="accent">Planned</Badge> : <Badge tone="success">Available</Badge>}
              <p className={s('planDescription')}>{plan.audience}</p>
              <ul className={s('planFeatures')}>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {plan.href ? (
                <Button href={plan.href} variant="primary">
                  {plan.cta}
                </Button>
              ) : (
                <Button type="button" variant="secondary" disabled>
                  {plan.cta}
                </Button>
              )}
            </Card>
          ))}
        </div>
      </Section>
    </main>
  )
}
