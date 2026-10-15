import { Badge } from '@hushvault/web-kit/ui'
import { Button } from '@hushvault/web-kit/ui'
import { Card } from '@hushvault/web-kit/ui'
import { Section } from '@hushvault/web-kit/ui'
import { PLANS } from '@/lib/plans'

import styles from './page.module.css'

const s = (name: string) => styles[name]

// Presentation/CTA for the marketing surface; plan data comes from the shared
// PLANS module so the tiers stay in sync with the in-product billing page.
const MARKETING = {
  Free: { cta: 'Review self-hosting notes', href: '/docs#self-hosting', tone: 'light' },
  Pro: { cta: 'Coming soon', href: null, tone: 'light' },
  Team: { cta: 'Coming soon', href: null, tone: 'light' },
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
          <span className="eyebrow">Plans and availability</span>
          <h1 className={s('pricingTitle')}>Self-hosting is available. Hosted plans are still planned.</h1>
          <p className={s('pricingSubtitle')}>
            There is no HushVault charge for the self-hosted version. Your infrastructure provider may charge for usage. Hosted Pro and Team plans are not available; prices are provisional and checkout is not live.
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
