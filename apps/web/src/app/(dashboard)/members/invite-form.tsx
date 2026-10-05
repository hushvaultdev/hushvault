'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { createInvite, type InviteSummary } from '@/lib/orgs-api'
import { ROLE_DESCRIPTION, ROLE_LABEL, assignableRoles, describeOrgError, validateInviteEmail } from '@/lib/orgs-helpers'
import type { Role } from '@/lib/types'

import styles from './members.module.css'

const s = (name: string) => styles[name]

export function InviteForm({
  orgId,
  orgName,
  actorRole,
  onCreated,
}: {
  orgId: string
  orgName: string
  actorRole: Role | undefined
  onCreated: (invite: InviteSummary) => void
}) {
  const roles = assignableRoles(actorRole)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>(roles.includes('member') ? 'member' : (roles[0] ?? 'viewer'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  // The single-use accept link, when the API returns one. Kept in component state only: never
  // written to storage, never logged, and gone as soon as this panel is dismissed.
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem = validateInviteEmail(email)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    setLink(null)
    try {
      const created = await createInvite(orgId, email.trim(), role)
      onCreated(created.invite)
      setSentTo(created.invite.email || email.trim())
      setLink(created.acceptUrl)
      setEmail('')
    } catch (err) {
      setError(describeOrgError(err, 'Could not send that invitation.'))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false) // clipboard blocked: the link is on screen and can be selected
    }
  }

  return (
    <Card tone="light" className={s('panel')}>
      <h2 className={s('panelTitle')}>Invite someone</h2>
      <p className={s('note')}>
        They get a single-use link that expires in seven days. It only works for the address below, so forwarding it to
        someone else does not let them in. They need a HushVault account on that address — they can create one from the
        link.
      </p>
      <form className={s('form')} onSubmit={(e) => void submit(e)} autoComplete="off">
        <Field
          label="Email address"
          name="inviteEmail"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="person@example.com"
          required
          autoComplete="off"
        />
        <label className={s('field')}>
          <span className={s('fieldLabel')}>Role</span>
          <select className={s('select')} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABEL[option]}
              </option>
            ))}
          </select>
          <span className={s('fieldHint')}>{ROLE_DESCRIPTION[role]}</span>
        </label>
        {error ? (
          <p className={s('error')} role="alert">
            {error}
          </p>
        ) : null}
        <div className={s('actions')}>
          <Button type="submit" variant="primary" loading={busy}>
            Send invitation
          </Button>
        </div>
      </form>

      {sentTo ? (
        <div className={s('sent')} role="status">
          <p className={s('note')}>
            Invitation sent to <strong>{sentTo}</strong> for {orgName}.
          </p>
          {link ? (
            <>
              <p className={s('note')}>
                If the email does not arrive, you can pass this link on yourself. It is shown once, works once, and only
                for that address.
              </p>
              <div className={s('linkRow')}>
                <input className={s('input')} readOnly value={link} aria-label="Single-use invitation link" />
                <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
            </>
          ) : null}
          <div className={s('actions')}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSentTo(null)
                setLink(null)
                setCopied(false)
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
