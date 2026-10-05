'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useOrgs } from '@/lib/org-context'
import { fetchInvites, fetchMembers, revokeInvite, type InviteSummary, type MemberSummary } from '@/lib/orgs-api'
import {
  ROLE_LABEL,
  canManageMembers,
  describeOrgError,
  expiryText,
  formatWhen,
  isOrgsUnavailable,
  orgNameOrId,
} from '@/lib/orgs-helpers'

import { InviteForm } from './invite-form'
import { MemberRow } from './member-row'
import styles from './members.module.css'

const s = (name: string) => styles[name]

type LoadState = 'loading' | 'ready' | 'missing' | 'forbidden' | 'error'

export default function MembersPage() {
  const router = useRouter()
  const { session } = useAuth()
  const { orgs, currentOrgId, currentRole } = useOrgs()
  const orgName = orgNameOrId(orgs, currentOrgId)
  const admin = canManageMembers(currentRole)

  const [members, setMembers] = useState<MemberSummary[]>([])
  const [memberState, setMemberState] = useState<LoadState>('loading')
  const [memberError, setMemberError] = useState<string | null>(null)

  const [invites, setInvites] = useState<InviteSummary[]>([])
  const [inviteState, setInviteState] = useState<LoadState>('loading')
  const [inviteError, setInviteError] = useState<string | null>(null)

  // This page is inside the org-keyed dashboard subtree, so a switch remounts it; the org id is
  // still a dependency so nothing here can outlive the organisation it was loaded for.
  useEffect(() => {
    if (!currentOrgId) return
    let cancelled = false
    setMemberState('loading')
    void fetchMembers(currentOrgId)
      .then((rows) => {
        if (cancelled) return
        setMembers(rows)
        setMemberState('ready')
        setMemberError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (isOrgsUnavailable(err)) {
          setMemberState('missing')
          return
        }
        if (err instanceof ApiError && err.status === 403) {
          setMemberState('forbidden')
          setMemberError(describeOrgError(err, 'Only owners and admins can see the member list.'))
          return
        }
        setMemberState('error')
        setMemberError(describeOrgError(err, 'Could not load the members of this organisation.'))
      })
    return () => {
      cancelled = true
    }
  }, [currentOrgId])

  useEffect(() => {
    if (!currentOrgId || !admin) return
    let cancelled = false
    setInviteState('loading')
    void fetchInvites(currentOrgId)
      .then((rows) => {
        if (cancelled) return
        setInvites(rows)
        setInviteState('ready')
        setInviteError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (isOrgsUnavailable(err)) {
          setInviteState('missing')
          return
        }
        setInviteState('error')
        setInviteError(describeOrgError(err, 'Could not load the open invitations.'))
      })
    return () => {
      cancelled = true
    }
  }, [currentOrgId, admin])

  async function onRevoke(invite: InviteSummary) {
    if (!currentOrgId) return
    setInviteError(null)
    try {
      await revokeInvite(currentOrgId, invite.id)
      setInvites((prev) => prev.filter((i) => i.id !== invite.id))
    } catch (err) {
      setInviteError(describeOrgError(err, 'Could not revoke that invitation.'))
    }
  }

  if (!currentOrgId) return null

  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Members</h1>
        <p className={s('pageSubtitle')}>
          Everyone with access to <strong>{orgName}</strong>. Members, projects and secrets are never shared between
          organisations.
        </p>
      </div>

      {memberState === 'missing' ? (
        <Card tone="light" className={s('panel')}>
          <h2 className={s('panelTitle')}>Not available on this deployment yet</h2>
          <p className={s('note')}>
            This API deployment does not have the members and invitations endpoints, so there is nothing to show. You are
            working in <strong>{orgName}</strong> and the rest of the dashboard is unaffected.
          </p>
        </Card>
      ) : null}

      {memberState === 'forbidden' ? (
        <Card tone="light" className={s('panel')}>
          <h2 className={s('panelTitle')}>You cannot see this list</h2>
          <p className={s('note')}>{memberError}</p>
        </Card>
      ) : null}

      {memberState === 'error' && memberError ? (
        <p className={s('error')} role="alert">
          {memberError}
        </p>
      ) : null}

      {memberState === 'loading' ? <p className={s('loading')}>Loading members…</p> : null}

      {memberState === 'ready' ? (
        <>
          {!admin ? (
            <p className={s('note')} role="note">
              Only owners and admins can invite people, change roles or remove members. You can still see who has
              access.
            </p>
          ) : null}
          {members.length === 0 ? (
            <EmptyState
              title="No members listed"
              description="The API returned no members for this organisation. If that looks wrong, reload the page."
            />
          ) : (
            <ul className={s('list')}>
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  orgId={currentOrgId}
                  member={member}
                  actorRole={currentRole}
                  isSelf={member.userId === session?.userId}
                  onChanged={(updated) =>
                    setMembers((prev) => prev.map((m) => (m.userId === updated.userId ? updated : m)))
                  }
                  onRemoved={(userId) => {
                    if (userId === session?.userId) {
                      // We just removed our own membership: the token still names this org, and
                      // every request in it will now be refused. Go and choose another one.
                      router.replace('/organisations?reason=MEMBERSHIP_REVOKED')
                      return
                    }
                    setMembers((prev) => prev.filter((m) => m.userId !== userId))
                  }}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}

      {admin && memberState !== 'missing' ? (
        <InviteForm
          orgId={currentOrgId}
          orgName={orgName}
          actorRole={currentRole}
          onCreated={(invite) =>
            setInvites((prev) => [invite, ...prev.filter((i) => i.email !== invite.email)])
          }
        />
      ) : null}

      {admin && inviteState !== 'missing' ? (
        <section className={s('block')} aria-labelledby="open-invites">
          <h2 className={s('panelTitle')} id="open-invites">
            Open invitations
          </h2>
          {inviteError ? (
            <p className={s('error')} role="alert">
              {inviteError}
            </p>
          ) : null}
          {inviteState === 'loading' ? <p className={s('loading')}>Loading invitations…</p> : null}
          {inviteState === 'ready' && invites.length === 0 ? (
            <p className={s('note')}>No invitations are waiting to be accepted.</p>
          ) : null}
          {invites.length > 0 ? (
            <ul className={s('list')}>
              {invites.map((invite) => {
                const expiry = expiryText(invite.expiresAt)
                return (
                  <li key={invite.id} className={s('row')}>
                    <div className={s('rowMain')}>
                      <strong>{invite.email}</strong>
                      <span className={s('meta')}>
                        {ROLE_LABEL[invite.role]} · invited {formatWhen(invite.createdAt)}
                        {expiry ? ` · ${expiry}` : ''}
                      </span>
                    </div>
                    <div className={s('actions')}>
                      <Button type="button" size="sm" variant="danger" onClick={() => void onRevoke(invite)}>
                        Revoke
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
