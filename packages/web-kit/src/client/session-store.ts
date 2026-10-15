// The in-memory session holder shared by the dashboard and the admin app. The access token (15
// minutes) lives in memory only: nothing in localStorage or sessionStorage for an XSS payload,
// extension or injected script to read and replay later. Persistence across reloads comes from the
// API's HttpOnly refresh cookie, which page scripts cannot see; the app's auth provider exchanges it
// for a fresh access token on load (see createApiClient().refreshSession).
//
// A store is created per app, so the two apps never share state or a hint key.

export interface SessionLike {
  token: string
}

export interface SessionStore<S extends SessionLike> {
  read(): S | null
  write(session: S): void
  clear(): void
  /** Who to tell when the session changes. Anything rendering the session subscribes instead of reading once. */
  subscribe(listener: () => void): () => void
  /** A non-secret hint that this browser has (or recently had) a session. */
  markHint(present: boolean): void
  hasHint(): boolean
  /** localStorage key of the hint, so other tabs can watch it and notice a sign-out. */
  readonly hintKey: string
}

export function createSessionStore<S extends SessionLike>(options: { hintKey: string }): SessionStore<S> {
  let current: S | null = null
  const listeners = new Set<() => void>()
  const { hintKey } = options

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  return {
    read: () => current,
    write(session) {
      current = session
      notify()
    },
    clear() {
      if (current === null) return
      current = null
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // The refresh cookie is HttpOnly and invisible to scripts, so without a hint every public page
    // view would POST /refresh and get a 401.
    markHint(present) {
      if (typeof window === 'undefined') return
      try {
        if (present) window.localStorage.setItem(hintKey, '1')
        else window.localStorage.removeItem(hintKey)
      } catch {
        // storage unavailable: the hint is only an optimisation
      }
    },
    hasHint() {
      if (typeof window === 'undefined') return false
      try {
        return window.localStorage.getItem(hintKey) === '1'
      } catch {
        return true // cannot tell: try the refresh
      }
    },
    hintKey,
  }
}
