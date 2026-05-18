import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'

import styles from './page.module.css'

const s = (name: string) => styles[name]

const plans = [
  {
    name: 'Free',
    price: '0',
    description: 'Built for solo developers and early projects.',
    features: [
      'Computed secrets',
      'Branch inheritance',
      'Share links',
      'Cloudflare Pages sync',
      'GitHub Actions sync',
    ],
    cta: 'Start Free',
    tone: 'light',
  },
  {
    name: 'Pro',
    price: '$12/mo',
    description: 'For active teams that want better operational control.',
    features: [
      'Unlimited projects',
      'Higher secret limits',
      'Drift detection',
      'Slack alerts',
      'Extended audit history',
    ],
    cta: 'Upgrade to Pro',
    tone: 'light',
  },
  {
    name: 'Team',
    price: '$99/mo',
    description: 'Startup-grade governance and shared infrastructure.',
    features: [
      'RBAC and SSO',
      'Compliance export',
      'Custom domain',
      'Full audit retention',
      'Priority support',
    ],
    cta: 'Talk to Sales',
    tone: 'dark',
  },
]

export default function PricingPage() {
  return (
    <main className={`page-shell ${s('pricingPage')}`}>
      <Section className={s('pricingHero')}>
        <div className="page-container">
          <span className="eyebrow">Pricing that matches your growth</span>
          <h1 className={s('pricingTitle')}>Own secrets now, upgrade only when the team needs it.</h1>
          <p className={s('pricingSubtitle')}>
            HushVault gives you the most valuable workflow features on the free plan, and then adds governance and automation as you scale.
          </p>
        </div>
      </Section>

      <Section>
        <div className={`${s('plansGrid')} page-container`}>
          {plans.map((plan) => (
            <Card key={plan.name} className={s('planCard')} tone={plan.tone as 'light' | 'dark'}>
              <div className={s('planHeader')}>
                <span className={s('planName')}>{plan.name}</span>
                <span className={s('planPrice')}>{plan.price}</span>
              </div>
              <p className={s('planDescription')}>{plan.description}</p>
              <ul className={s('planFeatures')}>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <Button href={plan.name === 'Free' ? '/' : '/sign-up'} variant={plan.tone === 'dark' ? 'secondary' : 'primary'}>
                {plan.cta}
              </Button>
            </Card>
          ))}
        </div>
      </Section>
    </main>
  )
}
