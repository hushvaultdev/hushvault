import { createSessionStore } from '@hushvault/web-kit/client'

import type { Session } from './types'

// The session holder and the hint live in the shared kit (packages/web-kit); this file only binds
// them to the dashboard's Session shape and hint key, and keeps the dashboard-specific route list.
// The access token is in memory only; persistence comes from the API's HttpOnly refresh cookie.
//
// The access token is refreshed from inside apiFetch, and a refresh can come back naming a
// *different* organisation: the refresh cookie is shared between tabs, so a switch in one tab
// rotates the family every tab will next refresh against. Anything that renders the session
// subscribes (subscribeSession) instead of reading once.

/** The dashboard's session store; the API client is configured with this same instance. */
export const sessionStore = createSessionStore<Session>({ hintKey: 'hv_has_session' })
const store = sessionStore

export const readSession = store.read
export const writeSession = store.write
export const clearSession = store.clear
export const subscribeSession = store.subscribe
export const markSessionHint = store.markHint
export const hasSessionHint = store.hasHint

/** The key other tabs watch, so a sign-out in one tab is noticed by the rest. */
export const SESSION_HINT_KEY = store.hintKey

/**
 * Paths where a missing hint must NOT be taken as "no session".
 *
 * The hint is plain localStorage and is absent in more situations than "signed out": site data
 * cleared selectively, storage blocked by policy or an extension, browser eviction, a cap on
 * script-writable storage for low-interaction sites. In every one of those the HttpOnly refresh
 * cookie is still valid, but a missing hint sent the user to /sign-in — and signing in again is
 * the only way to recreate the hint, so the failure looks like "it logs me out on every reload".
 * On a page that requires a session, spend the one refresh request and find out for real.
 *
 * `/invites` is in the list although it is reachable while signed out: the accept-invite page has
 * to know who the visitor actually is, and telling a signed-in user "sign in first" because a
 * localStorage flag went missing is the same failure in a worse place.
 */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/projects',
  '/audit',
  '/integrations',
  '/billing',
  '/onboarding',
  '/members',
  '/organisations',
  '/invites',
]

export function pathRequiresSession(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

// One-time cleanup of the pre-refresh-token storage so old 7-day tokens do not linger in browsers.
export function purgeLegacyStorage(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem('hv_session')
  } catch {
    // storage unavailable: nothing to purge
  }
}
