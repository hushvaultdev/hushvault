import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

type IntegrationStatus = 'not-connected' | 'coming-soon'

type Integration = {
  id: string
  name: string
  mark: string
  description: string
  status: IntegrationStatus
}

const integrations: Integration[] = [
  {
    id: 'cf-pages',
    name: 'Cloudflare Pages',
    mark: 'CF',
    description: 'Push secrets to Pages environment variables on save — no re-deploy required.',
    status: 'not-connected',
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    mark: 'GH',
    description: 'Sync secrets to GitHub repository and environment secrets for your CI workflows.',
    status: 'coming-soon',
  },
  {
    id: 'slack',
    name: 'Slack',
    mark: 'SL',
    description: 'Get alerts for expiring secrets, plan limits, and detected configuration drift.',
    status: 'coming-soon',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    mark: 'WH',
    description: 'Deliver HMAC-signed event payloads to your endpoints on every secret change.',
    status: 'coming-soon',
  },
]

export default function IntegrationsPage() {
  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Integrations</h1>
        <p className={s('pageSubtitle')}>
          Connect HushVault to where your team already deploys and communicates. More integrations are on the way.
        </p>
      </div>

      <div className={s('grid')}>
        {integrations.map((integration) => {
          const available = integration.status === 'not-connected'
          return (
            <Card key={integration.id} className={s('card')} tone="light">
              <div className={s('cardTop')}>
                <span className={s('mark')} aria-hidden="true">
                  {integration.mark}
                </span>
                {available ? (
                  <Badge tone="neutral">Not connected</Badge>
                ) : (
                  <Badge tone="accent">Coming soon</Badge>
                )}
              </div>

              <div className={s('body')}>
                <h2 className={s('name')}>{integration.name}</h2>
                <p className={s('description')}>{integration.description}</p>
              </div>

              <div className={s('action')}>
                <Button href="#" variant={available ? 'primary' : 'secondary'}>
                  {available ? 'Connect' : 'Coming soon'}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
