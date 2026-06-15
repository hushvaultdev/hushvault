'use client'

import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { ApiError, apiFetch } from '@/lib/api'

import styles from './audit.module.css'

const s = (name: string) => styles[name]

interface AuditRow {
  id: string
  org_id: string
  actor_id: string | null
  actor_type: string
  action: string
  resource_type: string | null
  resource_id: string | null
  ip: string | null
  user_agent: string | null
  timestamp: string
}

function shortId(id: string | null): string {
  if (!id) return '—'
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function actorTone(actorType: string): 'accent' | 'neutral' | 'success' {
  if (actorType === 'system') return 'accent'
  if (actorType === 'api_key') return 'neutral'
  return 'success'
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await apiFetch<AuditRow[]>('/api/audit'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the audit log.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <div className={s('pageHeader')}>
        <div>
          <h1 className={s('pageTitle')}>Audit log</h1>
          <p className={s('pageSubtitle')}>
            The most recent activity across your organisation. Showing up to 100 events.
          </p>
        </div>
      </div>

      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className={s('loading')}>Loading audit log…</p>
      ) : entries.length === 0 ? (
        <EmptyState
          title="No audit events yet"
          description="Activity such as secret reads, updates, and member changes will appear here."
        />
      ) : (
        <table className={s('table')}>
          <thead>
            <tr>
              <th>Action</th>
              <th>Resource</th>
              <th>Actor</th>
              <th>IP</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className={s('action')}>{entry.action}</td>
                <td className={s('resource')}>
                  {entry.resource_type ? (
                    <span>
                      <span className={s('resourceType')}>{entry.resource_type}</span>
                      {entry.resource_id ? (
                        <span className={s('resourceId')}> {shortId(entry.resource_id)}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className={s('muted')}>—</span>
                  )}
                </td>
                <td>
                  <Badge tone={actorTone(entry.actor_type)}>{entry.actor_type}</Badge>
                </td>
                <td className={s('ip')}>{entry.ip ?? '—'}</td>
                <td className={s('time')}>{formatTime(entry.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
