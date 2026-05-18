import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'

import styles from './page.module.css'

const s = (name: string) => styles[name]

const workflowSteps = [
  {
    title: 'Model environments once',
    body: 'Create development, staging, and production environments with inheritance built in, so new projects do not start from secret sprawl.',
  },
  {
    title: 'Sync where teams already deploy',
    body: 'Push changes to Cloudflare Pages and GitHub Actions without turning secrets management into another release ceremony.',
  },
  {
    title: 'Upgrade when operations mature',
    body: 'Keep the features developers love in Free, then add governance, automation, and trust controls when the team actually needs them.',
  },
]

const trustPoints = [
  'Envelope encryption with AES-256-GCM',
  'Cloudflare Workers, D1, and KV runtime',
  'Open source with self-hosting path',
  'Free tier designed for real projects',
]

const comparison = [
  { label: 'Computed secrets', hushvault: 'Included in Free', others: 'Often gated or missing' },
  { label: 'Branch inheritance', hushvault: 'Built into the core workflow', others: 'Usually a premium feature' },
  { label: 'Cloudflare-native sync', hushvault: 'First-class use case', others: 'Generic integration story' },
]

export default function HomePage() {
  return (
    <main className={`${s('page')} grid-background`}>
      <Section className={s('heroSection')}>
        <div className={`${s('heroGrid')} page-container`}>
          <div className={s('heroCopy')}>
            <span className="eyebrow">Secrets management for modern teams</span>
            <h1 className={s('heroTitle')}>Better workflow features than the free tier you have now. Lower friction than the paid tier you are avoiding.</h1>
            <p className={s('heroBody')}>
              HushVault gives developers the features they actually want on day one: computed secrets, environment inheritance, temporary sharing, and Cloudflare-native delivery without enterprise-first pricing.
            </p>
            <div className={s('heroActions')}>
              <Button href="#pricing" variant="primary">Start Free</Button>
              <Button href="#workflows" variant="secondary">See How It Works</Button>
            </div>
            <div className={s('heroStats')}>
              <Badge tone="neutral">$0 to self-host</Badge>
              <Badge tone="accent">Open source</Badge>
              <Badge tone="neutral">Built for Cloudflare and GitHub workflows</Badge>
            </div>
          </div>

          <Card className={s('productScene')} tone="dark">
            <div className={s('sceneToolbar')}>
              <span className={s('sceneTitle')}>Project: hushvault.dev</span>
              <Badge tone="success">Sync healthy</Badge>
            </div>

            <div className={s('scenePanels')}>
              <Card className={s('scenePanel')} tone="light">
                <div className={s('panelHeader')}>
                  <span>Secrets</span>
                  <span className={s('panelMeta')}>production</span>
                </div>
                <div className={s('secretRow')}>
                  <code>DATABASE_URL</code>
                  <span>Direct</span>
                </div>
                <div className={s('secretRow')}>
                  <code>REDIS_URL</code>
                  <span>Inherited</span>
                </div>
                <div className={s('secretRow')}>
                  <code>APP_ORIGIN</code>
                  <span>Computed</span>
                </div>
              </Card>

              <Card className={s('scenePanel')} tone="light">
                <div className={s('panelHeader')}>
                  <span>Recent activity</span>
                  <span className={s('panelMeta')}>2 min ago</span>
                </div>
                <p className={s('activityLine')}><strong>APP_ORIGIN</strong> updated for production</p>
                <p className={s('activityLine')}>Cloudflare Pages synced successfully</p>
                <p className={s('activityLine')}>Share link created for staging handoff</p>
              </Card>
            </div>

            <Card className={s('cliPanel')} tone="light">
              <div className={s('panelHeader')}>
                <span>CLI preview</span>
                <span className={s('panelMeta')}>terminal</span>
              </div>
              <pre className={s('cliCode')}>hushvault login{`\n`}hushvault init{`\n`}hushvault run -- pnpm dev</pre>
            </Card>
          </Card>
        </div>
      </Section>

      <Section id="trust">
        <div className={`${s('trustBand')} page-container`}>
          {trustPoints.map((item) => (
            <Card key={item} className={s('trustCard')}>
              <p>{item}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="workflows">
        <div className={`${s('sectionHeader')} page-container`}>
          <span className="eyebrow">Workflow-first product story</span>
          <h2>Secrets management that starts simple and scales with operational maturity.</h2>
          <p>
            The product should feel immediately useful for solo developers, then evolve into shared infrastructure as teams grow into collaboration, governance, and automation needs.
          </p>
        </div>
        <div className={`${s('workflowGrid')} page-container`}>
          {workflowSteps.map((step, index) => (
            <Card key={step.title} className={s('workflowCard')}>
              <span className={s('workflowIndex')}>0{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="pricing">
        <div className={`${s('pricingGrid')} page-container`}>
          <Card className={s('pricingIntro')}>
            <span className="eyebrow">Freemium that stays credible</span>
            <h2>Give away the features that create product love. Charge for the layers that remove operational pain.</h2>
            <p>
              HushVault should win on value density, not trial pressure. Free is for real projects. Pro removes friction. Team adds governance. Enterprise handles procurement.
            </p>
            <Button href="/pricing" variant="primary">View Pricing Strategy</Button>
          </Card>

          <Card className={s('comparisonCard')}>
            <div className={s('panelHeader')}>
              <span>Why teams switch</span>
              <span className={s('panelMeta')}>positioning</span>
            </div>
            <div className={s('comparisonRows')}>
              {comparison.map((row) => (
                <div key={row.label} className={s('comparisonRow')}>
                  <div>
                    <strong>{row.label}</strong>
                    <p>{row.hushvault}</p>
                  </div>
                  <span>{row.others}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Section>
    </main>
  )
}