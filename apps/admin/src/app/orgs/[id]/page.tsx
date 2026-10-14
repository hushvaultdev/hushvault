'use client'

import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, EmptyState } from '@hushvault/web-kit/ui'

import { Shell } from '@/components/shell'
import { getOrg, grantComp, revokeComp, setPlan } from '@/lib/admin-api'
import { describeAdminError } from '@/lib/admin-errors'
import { ApiError } from '@/lib/api'
import { formatExpiry, formatLimit, planTone } from '@/lib/format'
import type { OrgDetail, PlanTier } from '@/lib/types'
import { useFocusReturn } from '@/lib/use-focus-return'

import styles from '../../admin.module.css'

const s = (name: string) => styles[name]

const ALL_PLANS: PlanTier[] = ['free', 'pro', 'team', 'enterprise']
const COMP_PLANS: PlanTier[] = ['pro', 'team', 'enterprise']

export default function OrgDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [org, setOrg] = useState<OrgDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setNotFound(false)
    setLoadError(null)
    getOrg(id)
      .then(setOrg)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true)
          return
        }
        setLoadError(describeAdminError(err, 'Could not load this organisation.'))
      })
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  if (notFound) {
    return (
      <Shell>
        <EmptyState title="Organisation not found" description="It may have been deleted, or the link is wrong." />
      </Shell>
    )
  }

  if (loadError) {
    return (
      <Shell>
        <p className={s('error')} role="alert">{loadError}</p>
      </Shell>
    )
  }

  if (!org) {
    return (
      <Shell>
        <p className={s('muted')} role="status">Loading…</p>
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className={s('pageTitle')}>{org.name}</h1>
      <p className={s('muted')}>{org.slug} · created {new Date(org.createdAt).toLocaleDateString()}</p>

      <Card tone="light" className={s('grid')}>
        <dl className={s('kv')}>
          <dt>Plan</dt>
          <dd><Badge tone={planTone(org.plan)}>{org.plan}</Badge></dd>
          <dt>Expires</dt>
          <dd>{formatExpiry(org.planExpiresAt)}</dd>
          <dt>Members</dt>
          <dd>{org.memberCount}</dd>
        </dl>
        <dl className={s('kv')}>
          <dt>Sync targets</dt>
          <dd>{org.usage.syncTargetCount} of {formatLimit(org.entitlements.maxSyncTargets)}</dd>
          <dt>Auto runs / hour</dt>
          <dd>{formatLimit(org.entitlements.autoRunsPerHour)}</dd>
          <dt>Audit retention</dt>
          <dd>{org.entitlements.auditRetentionDays < 0 ? 'Unlimited' : `${org.entitlements.auditRetentionDays} days`}</dd>
          <dt>Compliance export</dt>
          <dd>{org.entitlements.complianceExport ? 'Yes' : 'No'}</dd>
          <dt>Projects</dt>
          <dd>{org.usage.projectCount} (limit: {formatLimit(org.entitlements.maxProjects)})</dd>
        </dl>
      </Card>

      <SetPlanPanel org={org} onChanged={load} />
      <CompPanel org={org} onChanged={load} />
    </Shell>
  )
}

function SetPlanPanel({ org, onChanged }: { org: OrgDetail; onChanged: () => void }) {
  const [plan, setPlanValue] = useState<PlanTier>(org.plan)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmRef = useFocusReturn<HTMLDivElement>(confirming)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      await setPlan(org.id, plan)
      setConfirming(false)
      onChanged()
    } catch (err) {
      setError(describeAdminError(err, 'Could not set that plan.'))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="light">
      <h2 className={s('pageTitle')}>Set plan</h2>
      <p className={s('note')}>
        An operator override, not a comp grant: this clears any comp expiry and sets the plan with no end date.
      </p>
      <div className={s('actions')}>
        <label className={s('field')}>
          <span className={s('fieldLabel')} id="set-plan-select-label">Plan</span>
          <select
            className={s('select')}
            aria-labelledby="set-plan-select-label"
            value={plan}
            disabled={busy}
            onChange={(e) => setPlanValue(e.target.value as PlanTier)}
          >
            {ALL_PLANS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" disabled={plan === org.plan || busy} onClick={() => setConfirming(true)}>
          Set plan
        </Button>
      </div>

      {confirming ? (
        <div ref={confirmRef} tabIndex={-1} className={s('confirm')} role="alertdialog" aria-label={`Confirm setting plan to ${plan}`}>
          <p className={s('note')}>
            This changes {org.name}&rsquo;s plan to {plan} immediately, with no expiry. It is recorded in the audit log.
          </p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void apply()}>
              Yes, set plan
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className={s('error')} role="alert">{error}</p> : null}
    </Card>
  )
}

function CompPanel({ org, onChanged }: { org: OrgDetail; onChanged: () => void }) {
  const [plan, setPlanValue] = useState<PlanTier>(COMP_PLANS[0]!)
  // Kept as the raw typed text, not a number: a controlled numeric <input> that re-clamps on
  // every keystroke shows a stale digit before the next one lands (clearing to '' snaps back to
  // "1" immediately, so typing "14" next becomes "1" + "1" + "4" = "114"). Only clamp on blur
  // and on submit; this field holds exactly what is on screen in between.
  const [daysText, setDaysText] = useState('30')
  const days = Math.min(365, Math.max(1, Math.trunc(Number(daysText)) || 1))
  const [confirmingGrant, setConfirmingGrant] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const grantConfirmRef = useFocusReturn<HTMLDivElement>(confirmingGrant)
  const revokeConfirmRef = useFocusReturn<HTMLDivElement>(confirmingRevoke)

  async function grant() {
    setBusy(true)
    setError(null)
    try {
      await grantComp(org.id, plan, days)
      setConfirmingGrant(false)
      onChanged()
    } catch (err) {
      setError(describeAdminError(err, 'Could not grant that comp.'))
      setConfirmingGrant(false)
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      await revokeComp(org.id)
      setConfirmingRevoke(false)
      onChanged()
    } catch (err) {
      setError(describeAdminError(err, 'Could not revoke that comp.'))
      setConfirmingRevoke(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="light">
      <h2 className={s('pageTitle')}>Comp licence</h2>
      <p className={s('note')}>
        A time-boxed plan (issue #104). Granting again while one is active overwrites it, not stacks it.
      </p>
      <div className={s('actions')}>
        <label className={s('field')}>
          <span className={s('fieldLabel')} id="comp-plan-select-label">Comp plan</span>
          <select
            className={s('select')}
            aria-labelledby="comp-plan-select-label"
            value={plan}
            disabled={busy}
            onChange={(e) => setPlanValue(e.target.value as PlanTier)}
          >
            {COMP_PLANS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className={s('field')}>
          <span className={s('fieldLabel')}>Days</span>
          <input
            className={s('numberInput')}
            type="number"
            min={1}
            max={365}
            value={daysText}
            disabled={busy}
            onChange={(e) => setDaysText(e.target.value)}
            onBlur={() => setDaysText(String(days))}
          />
        </label>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmingGrant(true)}>
          Grant comp
        </Button>
        {org.planExpiresAt !== null ? (
          <Button type="button" variant="danger" disabled={busy} onClick={() => setConfirmingRevoke(true)}>
            Revoke comp
          </Button>
        ) : null}
      </div>

      {confirmingGrant ? (
        <div ref={grantConfirmRef} tabIndex={-1} className={s('confirm')} role="alertdialog" aria-label={`Confirm granting ${plan} for ${days} days`}>
          <p className={s('note')}>
            Grants {org.name} the {plan} plan for {days} day{days === 1 ? '' : 's'}, replacing any existing comp. Recorded in the audit log.
          </p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void grant()}>
              Yes, grant
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingGrant(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {confirmingRevoke ? (
        <div ref={revokeConfirmRef} tabIndex={-1} className={s('confirm')} role="alertdialog" aria-label="Confirm revoking the comp licence">
          <p className={s('note')}>
            Reverts {org.name} to the free plan immediately. Data is kept; the comp licence is not.
          </p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void revoke()}>
              Yes, revoke
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingRevoke(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className={s('error')} role="alert">{error}</p> : null}
    </Card>
  )
}
