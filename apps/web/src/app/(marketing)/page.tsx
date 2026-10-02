import { plannedNamesPhrase } from '@hushvault/shared/integrations'

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
    title: 'Inject secrets where you run',
    body: `Inject secrets into any command with the CLI today. ${plannedNamesPhrase()} integrations are planned and not available yet.`,
  },
  {
    title: 'Grow into governance',
    body: 'Role-based access and an audit log are built in. SSO, compliance exports, and hosted billing tiers are planned for when teams need them.',
  },
]

const trustPoints = [
  'Envelope encryption with AES-256-GCM',
  'Cloudflare Workers, D1, and KV runtime',
  'Open source with self-hosting path',
  'Free to self-host on the Cloudflare free tier',
]

const comparison = [
  { label: 'Computed secrets', hushvault: 'Server-side ${NAME} templates, included', others: 'Varies by vendor' },
  { label: 'Branch inheritance', hushvault: 'Built into the core workflow', others: 'Varies by vendor' },
  { label: 'Cloudflare-native runtime', hushvault: 'Workers, D1, and KV; self-host for $0', others: 'Varies by vendor' },
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
              HushVault gives developers the features they actually want on day one: computed secrets, environment inheritance, one-time share links, and a Cloudflare-native architecture you can self-host for free. HushVault is an early, pre-release project.
            </p>
            <div className={s('heroActions')}>
              <Button href="/docs" variant="primary">Self-host for Free</Button>
              <Button href="#workflows" variant="secondary">See How It Works</Button>
            </div>
            <div className={s('heroStats')}>
              <Badge tone="neutral">$0 to self-host</Badge>
              <Badge tone="accent">Open source</Badge>
              <Badge tone="neutral">Built on Cloudflare Workers</Badge>
              <Badge tone="warning">Pre-release</Badge>
            </div>
          </div>

          <Card className={s('productScene')} tone="dark">
            <div className={s('sceneToolbar')}>
              <span className={s('sceneTitle')}>Project: hushvault.dev</span>
              <Badge tone="neutral">Sample data</Badge>
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
                  <span className={s('panelMeta')}>example</span>
                </div>
                <p className={s('activityLine')}><strong>APP_ORIGIN</strong> updated for production</p>
                <p className={s('activityLine')}>DATABASE_URL read via the CLI</p>
                <p className={s('activityLine')}>One-time share link created for staging handoff</p>
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
          <span className="eyebrow">Workflow-first</span>
          <h2>Secrets management that starts simple and scales with operational maturity.</h2>
          <p>
            HushVault aims to be immediately useful for solo developers, then grow into shared infrastructure as teams need collaboration, governance, and automation.
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
            <span className="eyebrow">Planned pricing</span>
            <h2>Give away the features that create product love. Charge for the layers that remove operational pain.</h2>
            <p>
              Self-hosting is free today. Hosted tiers are planned: Pro to remove friction, Team for governance, Enterprise for procurement. Billing is not live yet and prices are provisional.
            </p>
            <Button href="/pricing" variant="primary">View Planned Pricing</Button>
          </Card>

          <Card className={s('comparisonCard')}>
            <div className={s('panelHeader')}>
              <span>Why HushVault</span>
              <span className={s('panelMeta')}>what you get</span>
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