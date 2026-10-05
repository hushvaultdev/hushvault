import type { Session } from './types'

// The access token (15 minutes) lives in memory only: nothing in localStorage or sessionStorage for
// an XSS payload, extension or injected script to read and replay later. Persistence across reloads
// comes from the API's HttpOnly refresh cookie, which page scripts cannot see; the auth provider
// exchanges it for a fresh access token on load (see refreshSession in api.ts).
// Isolated here so the storage strategy can be swapped without touching callers.

let current: Session | null = null

// Who to tell when the stored session changes. The access token is refreshed from inside
// apiFetch, and a refresh can come back naming a *different* organisation — the refresh cookie is
// shared between tabs, so a switch in one tab rotates the family every tab will next refresh
// against. Without this, the provider's React state kept the old org while requests already went
// to the new one, which is how org A's name ends up over org B's data. Anything that renders the
// session subscribes instead of reading once.
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readSession(): Session | null {
  return current
}

export function writeSession(session: Session): void {
  current = session
  notify()
}

export function clearSession(): void {
  if (current === null) return
  current = null
  notify()
}

// A non-secret hint that this browser has (or recently had) a session. The refresh cookie is HttpOnly and
// invisible to scripts, so without a hint every public page view would POST /refresh and get a 401.
const HINT_KEY = 'hv_has_session'

export function markSessionHint(present: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (present) window.localStorage.setItem(HINT_KEY, '1')
    else window.localStorage.removeItem(HINT_KEY)
  } catch {
    // storage unavailable: the hint is only an optimisation
  }
}

export function hasSessionHint(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return true // cannot tell: try the refresh
  }
}

/** The key other tabs watch, so a sign-out in one tab is noticed by the rest. */
export const SESSION_HINT_KEY = HINT_KEY

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
