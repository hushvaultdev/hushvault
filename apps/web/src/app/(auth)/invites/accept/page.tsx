'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { readSession } from '@/lib/auth-storage'
import { acceptInvite, switchOrg, type AcceptedInvite } from '@/lib/orgs-api'
import { ROLE_LABEL, describeOrgError, inviteStep, invitedEmailFromError, parseInviteLink } from '@/lib/orgs-helpers'

import styles from '../../auth.module.css'

const s = (name: string) => styles[name]

/**
 * The page an emailed invitation link opens.
 *
 * Three arrivals have to work: signed out, signed in as the invited account, and signed in as a
 * different account. Nothing about the organisation is shown before the invitation is accepted —
 * a link holder who is not a member learns only that the link did not work for them, and why.
 *
 * The URL is left alone until the invitation is accepted: a visitor who has to sign in first
 * needs the link to still be here when they come back. The route sits in the (auth) group, whose
 * layout sets `referrer: no-referrer`, so the token is not handed to any third party, and the
 * fragment form of the link is never sent to a server at all.
 */
export default function AcceptInvitePage() {
  const router = useRouter()
  const { session, ready, isAuthenticated, applySession, logout } = useAuth()

  const [token, setToken] = useState<string | null>(null)
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [parsed, setParsed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState<AcceptedInvite | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Signed in as the wrong account: a separate state, because the answer is "sign out", not "try
  // again". The address comes from the API's refusal or the link's own hint, never a guess.
  const [mismatch, setMismatch] = useState(false)
  const [mismatchEmail, setMismatchEmail] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  useEffect(() => {
    const link = parseInviteLink(window.location.search, window.location.hash)
    setToken(link.token)
    setEmailHint(link.email)
    setParsed(true)
  }, [])

  const step = inviteStep({
    ready: ready && parsed,
    hasToken: token !== null,
    isAuthenticated,
    emailVerified: session?.emailVerified,
  })

  async function onAccept() {
    if (!token || busy) return
    setBusy(true)
    setError(null)
    setMismatch(false)
    setMismatchEmail(null)
    try {
      const result = await acceptInvite(token)
      setAccepted(result)
      // Used once and used now: take it out of the address bar and the history entry.
      window.history.replaceState(null, '', window.location.pathname)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVITE_EMAIL_MISMATCH') {
        setMismatch(true)
        setMismatchEmail(invitedEmailFromError(err, emailHint))
      }
      setError(describeOrgError(err, 'This invitation could not be accepted.'))
    } finally {
      setBusy(false)
    }
  }

  async function onOpenOrg() {
    if (!accepted?.orgId || busy) return
    setBusy(true)
    setSwitchError(null)
    try {
      const next = await switchOrg(accepted.orgId, readSession())
      if (!next || next.orgId !== accepted.orgId) {
        setSwitchError('Joined, but the organisation could not be opened from here. Pick it from your organisations.')
        return
      }
      applySession(next)
      router.push('/dashboard')
    } catch (err) {
      setSwitchError(describeOrgError(err, 'Joined, but could not open that organisation from here.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className={s('authPage')}>
      <Section className={s('authSection')}>
        <Card className={s('authCard')} tone="light">
          <span className="eyebrow">Invitation</span>

          {accepted ? (
            <>
              <h1>You’re in</h1>
              <p className={s('authText')} role="status">
                You are now a member of <strong>{accepted.orgName ?? 'the organisation'}</strong>
                {accepted.role ? ` as ${ROLE_LABEL[accepted.role]}` : ''}. Your other organisations are unchanged — the one you work
                in is shown at the top of every dashboard page.
              </p>
              {switchError ? (
                <p className={s('authError')} role="alert">
                  {switchError}
                </p>
              ) : null}
              <div className={s('authActions')}>
                {accepted.orgId ? (
                  <Button variant="primary" onClick={() => void onOpenOrg()} loading={busy}>
                    Open {accepted.orgName ?? 'this organisation'}
                  </Button>
                ) : null}
                <Button variant="secondary" href="/organisations">
                  See all my organisations
                </Button>
              </div>
            </>
          ) : step === 'loading' ? (
            <>
              <h1>Invitation</h1>
              <p className={s('authText')} role="status" aria-live="polite">
                Checking this invitation…
              </p>
            </>
          ) : step === 'no-token' ? (
            <>
              <h1>This link is incomplete</h1>
              <p className={s('authError')} role="alert">
                This invitation link is missing its token, so there is nothing to accept. Open the link from the
                invitation email again, or ask whoever invited you to send a new one.
              </p>
            </>
          ) : step === 'signed-out' ? (
            <>
              <h1>Sign in to accept</h1>
              <p className={s('authText')}>
                You have been invited to a HushVault organisation
                {emailHint ? (
                  <>
                    {' '}
                    at <strong>{emailHint}</strong>
                  </>
                ) : null}
                . An invitation belongs to an email address, so sign in with that address — or create an account on it —
                and then open this link again from the email.
              </p>
              <div className={s('authActions')}>
                <Button variant="primary" href="/sign-in">
                  Sign in
                </Button>
                <Button variant="secondary" href="/sign-up">
                  Create an account
                </Button>
              </div>
              <p className={s('authFooter')}>
                Keep this message: the link stays valid for seven days and can be used once.
              </p>
            </>
          ) : step === 'unverified' ? (
            <>
              <h1>Verify your email first</h1>
              <p className={s('authText')}>
                An invitation is accepted by a verified email address, so nobody can join an organisation with an
                address they have not proven they own. Confirm your address from the email we sent you, then open this
                invitation link again.
              </p>
              <div className={s('authActions')}>
                <Button variant="secondary" href="/dashboard">
                  Go to the dashboard to resend it
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1>Accept your invitation</h1>
              <p className={s('authText')}>
                You have been invited to join a HushVault organisation
                {emailHint ? (
                  <>
                    {' '}
                    at <strong>{emailHint}</strong>
                  </>
                ) : null}
                . Accepting adds your account to it; nothing in your current organisation changes.
              </p>
              {error ? (
                <p className={s('authError')} role="alert">
                  {error}
                </p>
              ) : null}
              {mismatch ? (
                <>
                  <p className={s('authText')}>
                    {mismatchEmail
                      ? `This invitation is for ${mismatchEmail}.`
                      : 'This invitation was sent to another address.'}{' '}
                    You are signed in with a different account. Sign out, sign in with the invited address, and open
                    this link again. Nothing else about that organisation is shown here, because you are not a member
                    of it.
                  </p>
                  <div className={s('authActions')}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        logout()
                        router.push('/sign-in')
                      }}
                    >
                      Sign out
                    </Button>
                  </div>
                </>
              ) : (
                /* An explicit click, for the same reason as email verification: link scanners and
                   mail clients prefetch URLs, and a prefetch must not consume the invitation. */
                <Button variant="primary" onClick={() => void onAccept()} loading={busy}>
                  Accept invitation
                </Button>
              )}
            </>
          )}
        </Card>
      </Section>
    </main>
  )
}
