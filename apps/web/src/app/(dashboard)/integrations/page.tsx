'use client'

import { INTEGRATIONS, type IntegrationInfo, type IntegrationStatus, type SyncTargetDto } from '@hushvault/shared/integrations'
import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/lib/auth-context'
import { listConnections, listProviders, listTargets, type ConnectionDto, type ProviderDto } from '@/lib/integrations-api'
import { describeApiError, isAdminRole } from '@/lib/integrations-helpers'

import { ConnectPanel } from './connect-panel'
import { ConnectionsList } from './connections-list'
import styles from './integrations.module.css'
import { TargetsSection } from './targets-section'

const s = (name: string) => styles[name]

// Cards come from the shared registry, so this page cannot claim more than the registry says.
const STATUS_LABEL: Record<IntegrationStatus, string> = { planned: 'Coming soon', beta: 'Beta', available: 'Available' }

export default function IntegrationsPage() {
  const { session, ready } = useAuth()
  const admin = isAdminRole(session?.role)
  const anyAvailable = INTEGRATIONS.some((i) => i.status !== 'planned')

  const [providers, setProviders] = useState<ProviderDto[]>([])
  const [connections, setConnections] = useState<ConnectionDto[]>([])
  const [targets, setTargets] = useState<SyncTargetDto[]>([])
  const [connecting, setConnecting] = useState<IntegrationInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadTargets = useCallback(async () => {
    try {
      setTargets(await listTargets())
    } catch (err) {
      setError(describeApiError(err, 'Could not load sync targets.'))
    }
  }, [])

  useEffect(() => {
    if (!ready || !session) return
    let cancelled = false
    void listProviders()
      .then((rows) => {
        if (!cancelled) setProviders(rows)
      })
      .catch(() => {
        // Registry cards still render; the API will reject unsupported providers on connect.
      })
    if (admin && anyAvailable) {
      void listConnections()
        .then((rows) => {
          if (!cancelled) setConnections(rows)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(describeApiError(err, 'Could not load connections.'))
        })
      void listTargets()
        .then((rows) => {
          if (!cancelled) setTargets(rows)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(describeApiError(err, 'Could not load sync targets.'))
        })
    }
    return () => {
      cancelled = true
    }
  }, [ready, session, admin, anyAvailable])

  const isConnectable = (id: string) => {
    const known = providers.find((p) => p.id === id)
    return known ? known.connectable : true
  }

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

      {anyAvailable && ready && !admin ? (
        <p className={s('note')} role="note">
          Only organisation admins can connect providers and manage sync targets. Ask an admin if you need a secret synced.
        </p>
      ) : null}

      <div className={s('grid')}>
        {INTEGRATIONS.map((integration) => {
          const planned = integration.status === 'planned'
          const canConnect = !planned && admin && isConnectable(integration.id)
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
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canConnect}
                  onClick={() => setConnecting(integration)}
                >
                  {planned ? 'Coming soon' : 'Connect'}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>

      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}

      {admin && anyAvailable ? (
        <>
          {connecting ? (
            <ConnectPanel
              provider={connecting}
              onCancel={() => setConnecting(null)}
              onConnected={(created) => {
                setConnections((prev) => [...prev, created])
                setConnecting(null)
              }}
            />
          ) : null}

          <ConnectionsList
            connections={connections}
            onChanged={(updated) => setConnections((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))}
            onRevoked={(id) => {
              setConnections((prev) => prev.filter((c) => c.id !== id))
              void loadTargets()
            }}
          />

          <TargetsSection connections={connections} targets={targets} onTargetsChange={setTargets} onRefresh={() => void loadTargets()} />
        </>
      ) : null}
    </div>
  )
}
