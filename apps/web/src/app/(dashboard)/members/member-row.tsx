'use client'

import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { removeMember, updateMemberRole, type MemberSummary } from '@/lib/orgs-api'
import { ROLE_DESCRIPTION, ROLE_LABEL, assignableRoles, describeOrgError, formatWhen, shortId } from '@/lib/orgs-helpers'
import { useFocusReturn } from '@/lib/use-focus-return'
import type { Role } from '@/lib/types'

import styles from './members.module.css'

const s = (name: string) => styles[name]

export function MemberRow({
  orgId,
  member,
  actorRole,
  isSelf,
  onChanged,
  onRemoved,
}: {
  orgId: string
  member: MemberSummary
  actorRole: Role | undefined
  isSelf: boolean
  onChanged: (member: MemberSummary) => void
  onRemoved: (userId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmRef = useFocusReturn<HTMLDivElement>(confirming)

  const assignable = assignableRoles(actorRole)
  // An admin cannot change an owner's role, and nobody is offered a change they cannot make. The
  // current role is always shown; it is only editable when the actor could set it again.
  const canChangeRole = assignable.includes(member.role)
  const canRemove = assignable.length > 0 || isSelf

  async function changeRole(next: Role) {
    if (next === member.role || busy) return
    setBusy(true)
    setError(null)
    try {
      await updateMemberRole(orgId, member.userId, next)
      onChanged({ ...member, role: next })
    } catch (err) {
      setError(describeOrgError(err, 'Could not change that role.'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await removeMember(orgId, member.userId)
      onRemoved(member.userId)
    } catch (err) {
      setError(describeOrgError(err, 'Could not remove that member.'))
      setBusy(false)
      setConfirming(false)
    }
  }

  const label = member.email ?? shortId(member.userId)

  return (
    <li className={s('row')}>
      <div className={s('rowMain')}>
        <strong>
          {label}
          {isSelf ? <span className={s('you')}> (you)</span> : null}
        </strong>
        <span className={s('meta')}>
          {member.email ? <span className={s('mono')}>{shortId(member.userId)}</span> : null}
          {member.email ? ' · ' : ''}
          Joined {formatWhen(member.joinedAt)}
        </span>
      </div>

      <div className={s('actions')}>
        {canChangeRole ? (
          <label className={s('roleField')}>
            <span className={s('srOnly')}>Role for {label}</span>
            <select
              className={s('select')}
              value={member.role}
              disabled={busy}
              onChange={(e) => void changeRole(e.target.value as Role)}
            >
              {assignable.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Badge tone="neutral">{ROLE_LABEL[member.role]}</Badge>
        )}
        {canRemove ? (
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
          >
            {isSelf ? 'Leave' : 'Remove'}
          </Button>
        ) : null}
      </div>

      {!canChangeRole && !isSelf ? (
        <p className={s('note')}>
          {ROLE_DESCRIPTION[member.role]} {member.role === 'owner' ? 'Only an owner can change an owner’s role.' : ''}
        </p>
      ) : null}

      {confirming ? (
        <div
          ref={confirmRef}
          tabIndex={-1}
          className={s('confirm')}
          role="alertdialog"
          aria-label={isSelf ? 'Confirm leaving this organisation' : `Confirm removing ${label}`}
        >
          <p className={s('note')}>
            {isSelf
              ? 'You will lose access to this organisation’s projects, secrets and audit log immediately, and you will be asked to choose another organisation. Someone with access has to invite you back.'
              : `${label} loses access to this organisation’s projects, secrets and audit log immediately. Their API keys in this organisation stop working. Secrets they already copied elsewhere are, of course, still copied — rotate anything they could read.`}
          </p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void remove()}>
              {isSelf ? 'Yes, leave' : 'Yes, remove'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
