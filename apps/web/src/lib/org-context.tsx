'use client'

import { usePathname, useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { refreshSession } from './api'
import { readSession } from './auth-storage'
import { useAuth } from './auth-context'
import { createOrg as createOrgRequest, fetchOrgs, switchOrg, type OrgSummary } from './orgs-api'
import { describeOrgError, isOrgsUnavailable } from './orgs-helpers'
import type { Role } from './types'

// Organisation context for the dashboard.
//
// The rule this file exists to keep: **the organisation on screen is the organisation the access
// token acts in.** `session.orgId` comes from the token the next request will carry, so it is the
// only answer to "which org am I in" — the list from GET /api/orgs supplies the *name* for that
// id and nothing else. When the id is not in the list, no name is shown (never a different org's
// name), and the user is sent to organisation selection instead of being left looking at an empty
// project list. Nothing about the current org is read from or written to local storage.

export type OrgStatus = 'loading' | 'ready' | 'missing' | 'error'

interface OrgContextValue {
  /** Every org the caller is a member of. Empty unless status is 'ready'. */
  orgs: OrgSummary[]
  status: OrgStatus
  /** The token's org as a named org, or null when the list has no entry for it. */
  currentOrg: OrgSummary | null
  /** The org the access token acts in. The authority for every org-scoped request. */
  currentOrgId: string | null
  /** The role the access token carries for that org. */
  currentRole: Role | undefined
  /** True once the list has loaded and the token's org is not among the caller's memberships. */
  membershipMissing: boolean
  /** The id being switched to while a switch is in flight. */
  switching: string | null
  error: string | null
  reload: () => void
  switchTo: (orgId: string) => Promise<void>
  create: (name: string) => Promise<void>
}

const OrgContext = createContext<OrgContextValue | null>(null)

interface Loaded {
  status: OrgStatus
  orgs: OrgSummary[]
  /** The org id the loaded list was fetched for, so a list from before a switch is never judged against the org after it. */
  loadedFor: string | null
}

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { session, ready, applySession } = useAuth()
  const orgId = session?.orgId ?? null

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading', orgs: [], loadedFor: null })
  const [switching, setSwitching] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!ready || !orgId) return
    let cancelled = false
    // The orgs already in hand are kept while the list reloads. An id-to-name mapping does not
    // go stale in a dangerous way — only membership does — so the organisation just switched to
    // can be named straight away, while `loadedFor` keeps the membership check honest.
    setLoaded((prev) => (prev.loadedFor === orgId ? prev : { status: 'loading', orgs: prev.orgs, loadedFor: null }))
    void fetchOrgs()
      .then((list) => {
        if (cancelled) return
        setLoaded({ status: 'ready', orgs: list.orgs, loadedFor: orgId })
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A deployment without these endpoints must not break the dashboard: fall back to the
        // one organisation the token names and say switching is unavailable.
        if (isOrgsUnavailable(err)) {
          setLoaded((prev) => ({ status: 'missing', orgs: prev.orgs, loadedFor: orgId }))
          setError(null)
          return
        }
        setLoaded((prev) => ({ status: 'error', orgs: prev.orgs, loadedFor: orgId }))
        setError(describeOrgError(err, 'Could not load your organisations.'))
      })
    return () => {
      cancelled = true
    }
    // Refetched whenever the token's org changes, so the name always belongs to the current org.
  }, [ready, orgId, reloadToken])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  // The name for the id the token carries, from whichever list we hold. Null — and so the id is
  // shown instead — when no list has an entry for that id.
  const currentOrg = useMemo(
    () => (orgId ? (loaded.orgs.find((o) => o.id === orgId) ?? null) : null),
    [loaded.orgs, orgId],
  )

  // Judged only against a list fetched for this org, so a list from before a switch can never
  // declare the org just switched into "not yours".
  const membershipMissing =
    loaded.status === 'ready' && orgId !== null && loaded.loadedFor === orgId && currentOrg === null

  // The token names an org the caller is not a member of (removed, or revoked between requests).
  // Every org-scoped request will refuse, so go and choose an organisation instead of showing a
  // dashboard full of empty lists. apiFetch does the same for a NOT_A_MEMBER/MEMBERSHIP_REVOKED
  // refusal; this covers the case where the list is the first thing to notice.
  const redirected = useRef(false)
  useEffect(() => {
    if (!membershipMissing || pathname.startsWith('/organisations')) return
    if (redirected.current) return
    redirected.current = true
    router.replace('/organisations?reason=NOT_A_MEMBER')
  }, [membershipMissing, pathname, router])

  const switchTo = useCallback(
    async (target: string) => {
      if (!target || switching) return
      setSwitching(target)
      setError(null)
      try {
        let next = await switchOrg(target, readSession())
        if (!next || next.orgId !== target) {
          // The response did not carry a session we can use. The switch rotated the refresh
          // cookie into the target org's family, so trade that for the authoritative session
          // rather than keeping a token for the old org under the new org's name.
          next = await refreshSession()
        }
        if (!next || next.orgId !== target) {
          setError('Switched organisation, but no new session came back. Reload the page to continue.')
          return
        }
        applySession(next)
        // Every list in the dashboard is org-scoped, and ids from the old org (a project route,
        // for instance) mean nothing in the new one. Go to the top of the dashboard; the subtree
        // is also keyed on the org id, so each page refetches from scratch.
        router.replace('/dashboard')
      } catch (err) {
        setError(describeOrgError(err, 'Could not switch organisation.'))
      } finally {
        setSwitching(null)
      }
    },
    [applySession, router, switching],
  )

  const create = useCallback(
    async (name: string) => {
      setError(null)
      const created = await createOrgRequest(name)
      reload()
      if (created) await switchTo(created.id)
    },
    [reload, switchTo],
  )

  const value = useMemo<OrgContextValue>(
    () => ({
      orgs: loaded.orgs,
      status: loaded.status,
      currentOrg,
      currentOrgId: orgId,
      currentRole: session?.role,
      membershipMissing,
      switching,
      error,
      reload,
      switchTo,
      create,
    }),
    [loaded, currentOrg, orgId, session?.role, membershipMissing, switching, error, reload, switchTo, create],
  )

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrgs(): OrgContextValue {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrgs must be used within an OrgProvider')
  return ctx
}
