import type { Session } from './types'

// The access token (15 minutes) lives in memory only: nothing in localStorage or sessionStorage for
// an XSS payload, extension or injected script to read and replay later. Persistence across reloads
// comes from the API's HttpOnly refresh cookie, which page scripts cannot see; the auth provider
// exchanges it for a fresh access token on load (see refreshSession in api.ts).
// Isolated here so the storage strategy can be swapped without touching callers.

let current: Session | null = null

export function readSession(): Session | null {
  return current
}

export function writeSession(session: Session): void {
  current = session
}

export function clearSession(): void {
  current = null
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
