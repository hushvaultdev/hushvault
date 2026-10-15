import Link from 'next/link'

import { Badge } from '@hushvault/web-kit/ui'
import { Button } from '@hushvault/web-kit/ui'
import { Card } from '@hushvault/web-kit/ui'
import { Section } from '@hushvault/web-kit/ui'

import styles from './page.module.css'

const s = (name: string) => styles[name]

const workflowSteps = [
  {
    number: '01',
    title: 'Group by project',
    body: 'Keep application secrets together and separate development, staging, and production values.',
    detail: 'Projects · Environments',
  },
  {
    number: '02',
    title: 'Resolve with context',
    body: 'Inherit values between environments and compose computed secrets from other values.',
    detail: 'Inheritance · Computed values',
  },
  {
    number: '03',
    title: 'Run with the CLI',
    body: 'Load secrets into a process when you run it, keeping local env files out of the workflow.',
    detail: 'hushvault run -- pnpm dev',
  },
]

export default function HomePage() {
  return (
    <main className={s('page')}>
      <Section className={s('heroSection')}>
        <div className={`${s('heroGrid')} page-container`}>
          <div className={s('heroCopy')}>
            <div className={s('heroEyebrow')}>
              <Badge tone="warning">Pre-release</Badge>
              <span>Open source secrets management</span>
            </div>
            <h1 className={s('heroTitle')}>Secrets for every environment. Clear control for every developer.</h1>
            <p className={s('heroBody')}>
              Organise application secrets by project, resolve environment inheritance, and inject values into local commands with the HushVault CLI.
            </p>
            <p className={s('releaseNote')}>
              HushVault is early software. It is not production-ready and has not had an independent security audit.
            </p>
            <div className={s('heroActions')}>
              <Button href="/docs#self-hosting" variant="primary">Read self-hosting status</Button>
              <Button href="#workflows" variant="secondary">Explore the workflow</Button>
            </div>
            <div className={s('heroMeta')}>
              <span>Cloudflare Workers + D1 + KV</span>
              <span aria-hidden="true">·</span>
              <span>Self-hosted deployment</span>
            </div>
          </div>

          <Card className={s('productScene')} tone="light">
            <div className={s('sceneToolbar')}>
              <div>
                <span className={s('sceneKicker')}>PROJECT</span>
                <strong className={s('sceneTitle')}>billing-api</strong>
              </div>
              <Badge tone="neutral">Example data</Badge>
            </div>
            <div className={s('environmentBar')}>
              <span>Environment</span>
              <strong>production</strong>
              <span className={s('environmentMarker')} aria-hidden="true">▾</span>
            </div>
            <div className={s('secretList')} aria-label="Example secrets, values hidden">
              <div className={s('secretRow')}>
                <span><code>DATABASE_URL</code><small>Direct value</small></span>
                <span className={s('secretMask')} aria-label="Value hidden">••••••••</span>
              </div>
              <div className={s('secretRow')}>
                <span><code>REDIS_URL</code><small>Inherited from staging</small></span>
                <Badge tone="neutral">Inherited</Badge>
              </div>
              <div className={s('secretRow')}>
                <span><code>APP_ORIGIN</code><small>Computed from environment</small></span>
                <Badge tone="accent">Computed</Badge>
              </div>
            </div>
            <div className={s('terminalPanel')}>
              <div className={s('terminalHeading')}><span>RUN LOCALLY</span><span>CLI</span></div>
              <code>hushvault run -- pnpm dev</code>
            </div>
            <p className={s('sceneCaption')}>Illustrative interface · no live customer data</p>
          </Card>
        </div>
      </Section>

      <Section id="workflows" className={s('workflowSection')}>
        <div className={`${s('sectionHeader')} page-container`}>
          <span className="eyebrow">A clear path from local to production</span>
          <h2>Keep secrets close to the code that needs them.</h2>
          <p>One workflow for organising values, choosing an environment, and running your application.</p>
        </div>
        <div className={`${s('workflowGrid')} page-container`}>
          {workflowSteps.map((step) => (
            <Card key={step.number} className={s('workflowCard')} tone="light">
              <span className={s('workflowNumber')}>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <span className={s('workflowDetail')}>{step.detail}</span>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="trust" className={s('trustSection')}>
        <div className={`${s('trustLayout')} page-container`}>
          <div className={s('trustCopy')}>
            <span className="eyebrow">Security, stated plainly</span>
            <h2>Understand the trust boundary before you deploy.</h2>
            <p>Stored values use AES-256-GCM envelope encryption. The deployment server holds the master key and decrypts values when serving them; HushVault is not zero-knowledge for stored secrets.</p>
            <Link href="/security" className={s('textLink')}>Read the security model <span aria-hidden="true">→</span></Link>
          </div>
          <Card className={s('trustCard')} tone="light">
            <div className={s('trustStatus')}><span className={s('statusDot')} aria-hidden="true" /> Early access status</div>
            <h3>Evaluate with care</h3>
            <ul>
              <li>Pre-release software</li>
              <li>No independent security audit</li>
              <li>Not production-ready</li>
            </ul>
            <p>Review the code and threat model before storing sensitive values.</p>
          </Card>
        </div>
      </Section>

      <Section className={s('capabilitySection')}>
        <div className={`${s('capabilityHeader')} page-container`}>
          <div>
            <span className="eyebrow">Product status</span>
            <h2>Available today, clearly separated from the roadmap.</h2>
          </div>
          <p>HushVault is changing quickly. Check current status before planning around a capability.</p>
        </div>
        <div className={`${s('capabilityGrid')} page-container`}>
          <Card className={s('capabilityCard')} tone="light">
            <Badge tone="success">Available</Badge>
            <h3>Core secrets workflow</h3>
            <p>Projects, environments, encrypted secret storage, inheritance, computed values, and CLI commands.</p>
          </Card>
          <Card className={s('capabilityCard')} tone="light">
            <Badge tone="warning">Limited beta</Badge>
            <h3>Cloudflare Workers secrets sync (beta)</h3>
            <p>One-way manual sync; it has not yet been verified against a live Cloudflare account.</p>
          </Card>
          <Card className={s('capabilityCard')} tone="light">
            <Badge tone="neutral">Planned</Badge>
            <h3>Hosted plans and more integrations</h3>
            <p>Hosted billing and several provider integrations are not available yet.</p>
          </Card>
        </div>
      </Section>

      <Section className={s('guideSection')}>
        <div className={`${s('guideCard')} page-container`}>
          <div>
            <span className="eyebrow">Before you deploy</span>
            <h2>Start with the current setup and deployment notes.</h2>
            <p>The existing self-hosting material is still being made portable and verified. Review its limitations and account-specific settings before following it.</p>
          </div>
          <Button href="/docs#self-hosting" variant="primary">Read self-hosting status</Button>
        </div>
      </Section>
    </main>
  )
}
