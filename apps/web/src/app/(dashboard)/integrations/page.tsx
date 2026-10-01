import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

type IntegrationStatus = 'coming-soon'

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
    description: 'Planned: sync secrets to Cloudflare Pages environment variables.',
    status: 'coming-soon',
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    mark: 'GH',
    description: 'Planned: sync secrets to GitHub repository and environment secrets for your CI workflows.',
    status: 'coming-soon',
  },
  {
    id: 'slack',
    name: 'Slack',
    mark: 'SL',
    description: 'Planned: alerts for expiring secrets and configuration drift.',
    status: 'coming-soon',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    mark: 'WH',
    description: 'Planned: signed event payloads delivered to your endpoints on secret changes.',
    status: 'coming-soon',
  },
]

export default function IntegrationsPage() {
  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Integrations</h1>
        <p className={s('pageSubtitle')}>
          No integrations are available yet. The integrations below are planned; nothing here is connected.
        </p>
      </div>

      <div className={s('grid')}>
        {integrations.map((integration) => {
          return (
            <Card key={integration.id} className={s('card')} tone="light">
              <div className={s('cardTop')}>
                <span className={s('mark')} aria-hidden="true">
                  {integration.mark}
                </span>
                <Badge tone="accent">Coming soon</Badge>
              </div>

              <div className={s('body')}>
                <h2 className={s('name')}>{integration.name}</h2>
                <p className={s('description')}>{integration.description}</p>
              </div>

              <div className={s('action')}>
                <Button type="button" variant="secondary" disabled>
                  Coming soon
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
