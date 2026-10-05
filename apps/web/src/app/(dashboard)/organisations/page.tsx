'use client'

import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { useOrgs } from '@/lib/org-context'
import { ROLE_LABEL, describeOrgError, membershipReason, shortId, validateOrgName } from '@/lib/orgs-helpers'

import styles from './organisations.module.css'

const s = (name: string) => styles[name]

const MEMBERSHIP_REASONS = ['NOT_A_MEMBER', 'MEMBERSHIP_REVOKED']

/**
 * Organisation selection and creation. This is where a session lands when the organisation its
 * token names is no longer available to it — so it must work with no usable organisation at all,
 * and it never reads org-scoped data.
 */
export default function OrganisationsPage() {
  const { orgs, status, currentOrg, currentOrgId, membershipMissing, switching, switchTo, create, error, reload } = useOrgs()
  const [reason, setReason] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('reason')
    setReason(value && MEMBERSHIP_REASONS.includes(value) ? value : null)
  }, [])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (creating) return
    const problem = validateOrgName(name)
    if (problem) {
      setFormError(problem)
      return
    }
    setCreating(true)
    setFormError(null)
    try {
      await create(name.trim())
      setName('')
    } catch (err) {
      setFormError(describeOrgError(err, 'Could not create the organisation.'))
    } finally {
      setCreating(false)
    }
  }

  const showNotice = reason !== null || membershipMissing

  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Organisations</h1>
        <p className={s('pageSubtitle')}>
          Every project, secret and audit entry belongs to one organisation. You work in one at a time, and the
          organisation you are in is shown at the top of every page.
        </p>
      </div>

      {showNotice ? (
        <p className={s('notice')} role="status">
          {membershipReason(reason)}
        </p>
      ) : null}

      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}

      {status === 'loading' ? <p className={s('loading')}>Loading your organisations…</p> : null}

      {status === 'missing' ? (
        <Card tone="light" className={s('panel')}>
          <h2 className={s('panelTitle')}>One organisation</h2>
          <p className={s('note')}>
            This API deployment does not offer multiple organisations yet, so there is nothing to switch between. You are
            working in{' '}
            <strong>{currentOrg?.name ?? shortId(currentOrgId)}</strong>, and everything else on the dashboard works as
            normal.
          </p>
        </Card>
      ) : null}

      {status === 'error' ? (
        <Card tone="light" className={s('panel')}>
          <h2 className={s('panelTitle')}>Your organisations could not be loaded</h2>
          <p className={s('note')}>
            You are still signed in and working in <strong>{currentOrg?.name ?? shortId(currentOrgId)}</strong>. Only the
            list of organisations is missing.
          </p>
          <div className={s('actions')}>
            <Button type="button" variant="secondary" onClick={reload}>
              Try again
            </Button>
          </div>
        </Card>
      ) : null}

      {status === 'ready' ? (
        <ul className={s('list')}>
          {orgs.map((org) => {
            const isCurrent = org.id === currentOrgId
            return (
              <li key={org.id} className={s('row')}>
                <div className={s('rowMain')}>
                  <strong>{org.name}</strong>
                  <span className={s('meta')}>
                    {ROLE_LABEL[org.role]}
                    {org.plan ? ` · ${org.plan} plan` : ''} · <span className={s('mono')}>{org.id}</span>
                  </span>
                </div>
                <div className={s('actions')}>
                  {isCurrent ? (
                    <Badge tone="success">Current</Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      loading={switching === org.id}
                      disabled={switching !== null}
                      onClick={() => void switchTo(org.id)}
                    >
                      Switch to this
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      {status === 'ready' ? (
        <Card tone="light" className={s('panel')}>
          <h2 className={s('panelTitle')}>New organisation</h2>
          <p className={s('note')}>
            You become its owner. It starts empty — projects, secrets and members are never shared between
            organisations.
          </p>
          <form className={s('form')} onSubmit={(e) => void onCreate(e)}>
            <Field
              label="Organisation name"
              name="orgName"
              value={name}
              onChange={setName}
              placeholder="Acme Ltd"
              required
              hint="2 to 120 characters. Visible to everyone you invite."
            />
            {formError ? (
              <p className={s('error')} role="alert">
                {formError}
              </p>
            ) : null}
            <div className={s('actions')}>
              <Button type="submit" variant="primary" loading={creating || switching !== null}>
                Create and switch to it
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  )
}
