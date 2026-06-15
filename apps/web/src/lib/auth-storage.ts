import type { Session } from './types'

// The web client is a Bearer-token consumer of the HushVault API, which runs
// on a separate origin and does not set cookies. The session (JWT + identifiers)
// is kept in localStorage and attached as `Authorization: Bearer <token>`.
// Isolated here so the storage strategy can be swapped without touching callers.

const STORAGE_KEY = 'hv_session'

export function readSession(): Session | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Session
    if (!parsed?.token) return null
    return parsed
  } catch {
    return null
  }
}

export function writeSession(session: Session): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}
