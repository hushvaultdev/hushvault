'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { apiFetch, endSession, refreshSession, ApiError } from './api'
import { clearSession, hasSessionHint, markSessionHint, readSession, subscribeSession, writeSession } from './auth-storage'
import type { Session } from './types'

interface AuthContextValue {
  session: Session | null
  isAuthenticated: boolean
  // True until the stored session has been read AND confirmed as a platform admin.
  ready: boolean
  // Set once sign-in succeeds but the account is not a platform admin: the API's /api/admin/*
  // routes would 403 every call, so this is surfaced on the sign-in form instead of showing an
  // empty, broken shell.
  notAdmin: boolean
  // Set when the admin check during cold-load restore could not reach a verdict (transient 500,
  // network blip). The session is kept intact so a retry succeeds; the shell asks the user to
  // retry rather than silently signing them out. Issue #111.
  checkFailed: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  retryCheck: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

// A cheap call that only a platform admin can make. Used right after sign-in (and after a page
// reload restores a session) to confirm the account is actually an admin before showing anything.
// This is a client-side convenience, not the security boundary — the API enforces
// requirePlatformAdmin on every /api/admin/* call regardless of what this check says.
//
// Returns true/false for a definite answer; rethrows anything else (5xx, network, unexpected
// shape). Callers decide whether to treat a thrown error as "not an admin" (never, after #111) or
// "could not confirm — keep the session and offer a retry."
function confirmPlatformAdmin(): Promise<boolean> {
  return apiFetch('/api/admin/orgs', { method: 'GET' })
    .then(() => true)
    .catch((err) => {
      if (err instanceof ApiError && err.status === 403) return false
      throw err
    })
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [notAdmin, setNotAdmin] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)
  const [restoreTick, setRestoreTick] = useState(0)

  useEffect(() => {
    const shouldRefresh = hasSessionHint()
    if (!shouldRefresh) {
      setReady(true)
      return
    }
    let cancelled = false
    setCheckFailed(false)
    void refreshSession().then(async (next) => {
      if (cancelled) return
      if (!next) {
        setReady(true)
        return
      }
      let isAdmin: boolean
      try {
        isAdmin = await confirmPlatformAdmin()
      } catch {
        // The check could not reach a verdict (transient 500, offline, unexpected response).
        // Do NOT clear the session or the hint: the credentials are still valid, and a retry
        // (manual, or just reloading once the API recovers) succeeds without re-authenticating.
        // Issue #111: this used to collapse into "not an admin" and log the user out.
        if (cancelled) return
        setSession(next)
        setCheckFailed(true)
        setReady(true)
        return
      }
      if (cancelled) return
      if (!isAdmin) {
        clearSession()
        markSessionHint(false)
        setSession(null)
        setNotAdmin(true)
      } else {
        setSession(next)
      }
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [restoreTick])

  useEffect(() => {
    const sync = () => setSession(readSession())
    const unsubscribe = subscribeSession(sync)
    sync()
    return unsubscribe
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setNotAdmin(false)
    setCheckFailed(false)
    const next = await apiFetch<{ token: string; userId: string }>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    })
    const clean: Session = { token: next.token, userId: next.userId }
    // Check admin status BEFORE committing the session, so a non-admin never sees the shell even
    // for an instant. The sign-in form reports "not an administrator" ONLY on a definite 403 —
    // any other failure is a generic sign-in error (issue #111), since reporting "not an
    // administrator" for a transient 500 would be actively wrong.
    writeSession(clean)
    let isAdmin: boolean
    try {
      isAdmin = await confirmPlatformAdmin()
    } catch (err) {
      await endSession()
      throw err instanceof ApiError
        ? err
        : new ApiError(0, 'ADMIN_CHECK_FAILED', 'Could not confirm platform admin access. Try again.')
    }
    if (!isAdmin) {
      await endSession()
      setNotAdmin(true)
      throw new ApiError(403, 'FORBIDDEN', 'This account is not a platform administrator.')
    }
    markSessionHint(true)
    setSession(clean)
  }, [])

  const logout = useCallback(() => {
    void endSession()
    setSession(null)
  }, [])

  // Rerun the mount effect's refresh + admin check, after a transient failure the user can retry.
  const retryCheck = useCallback(() => {
    setCheckFailed(false)
    setReady(false)
    setRestoreTick((t) => t + 1)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ session, isAuthenticated: session !== null, ready, notAdmin, checkFailed, login, logout, retryCheck }),
    [session, ready, notAdmin, checkFailed, login, logout, retryCheck],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
