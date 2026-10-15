'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card } from '@hushvault/web-kit/ui'

import { Shell } from '@/components/shell'
import { listOrgs } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { planTone, formatExpiry } from '@/lib/format'
import type { OrgSummary } from '@/lib/types'

import styles from './admin.module.css'

const s = (name: string) => styles[name]

export default function OrgListPage() {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    listOrgs()
      .then((page) => {
        if (cancelled) return
        setOrgs(page.data)
        setNextCursor(page.nextCursor)
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load organisations.') })
    return () => { cancelled = true }
  }, [])

  const loadMore = useCallback(() => {
    if (!nextCursor) return
    setLoadingMore(true)
    setError(null)
    listOrgs(nextCursor)
      .then((page) => {
        setOrgs((prev) => [...(prev ?? []), ...page.data])
        setNextCursor(page.nextCursor)
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load more organisations.'))
      .finally(() => setLoadingMore(false))
  }, [nextCursor])

  return (
    <Shell>
      <h1 className={s('pageTitle')}>Organisations</h1>
      <p className={s('muted')}>Newest first. Open one to change its plan or grant a comp.</p>
      {error ? <p className={s('error')} role="alert">{error}</p> : null}
      {orgs === null && !error ? <p className={s('muted')} role="status">Loading…</p> : null}
      {orgs ? (
        <Card tone="light">
          <div className={s('tableWrap')}>
            <table className={s('table')}>
              <thead>
                <tr><th>Name</th><th>Plan</th><th>Expires</th><th>Members</th><th>Created</th></tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id}>
                    <td><Link href={`/orgs/${encodeURIComponent(o.id)}`}>{o.name}</Link></td>
                    <td><Badge tone={planTone(o.plan)}>{o.plan}</Badge></td>
                    <td>{formatExpiry(o.planExpiresAt)}</td>
                    <td>{o.memberCount}</td>
                    <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor ? (
            <div className={s('actions')}>
              <Button variant="secondary" onClick={loadMore} loading={loadingMore}>Load more</Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </Shell>
  )
}
