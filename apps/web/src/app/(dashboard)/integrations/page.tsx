import { INTEGRATIONS, type IntegrationStatus } from '@hushvault/shared/integrations'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

// Cards come from the shared registry, so this page cannot claim more than the registry says.
const STATUS_LABEL: Record<IntegrationStatus, string> = { planned: 'Coming soon', beta: 'Beta', available: 'Available' }

export default function IntegrationsPage() {
  const anyAvailable = INTEGRATIONS.some((i) => i.status !== 'planned')
  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Integrations</h1>
        <p className={s('pageSubtitle')}>
          {anyAvailable
            ? 'Integrations marked Beta or Available can be connected. The rest are planned; nothing else is connected.'
            : 'No integrations are available yet. The integrations below are planned; nothing here is connected.'}
        </p>
      </div>

      <div className={s('grid')}>
        {INTEGRATIONS.map((integration) => {
          const planned = integration.status === 'planned'
          return (
            <Card key={integration.id} className={s('card')} tone="light">
              <div className={s('cardTop')}>
                <span className={s('mark')} aria-hidden="true">
                  {integration.mark}
                </span>
                <Badge tone="accent">{STATUS_LABEL[integration.status]}</Badge>
              </div>

              <div className={s('body')}>
                <h2 className={s('name')}>{integration.name}</h2>
                <p className={s('description')}>{integration.summary}</p>
              </div>

              <div className={s('action')}>
                <Button type="button" variant="secondary" disabled={planned}>
                  {planned ? 'Coming soon' : 'Connect'}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
