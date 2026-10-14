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
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

// A cheap call that only a platform admin can make. Used right after sign-in (and after a page
// reload restores a session) to confirm the account is actually an admin before showing anything.
// This is a client-side convenience, not the security boundary — the API enforces
// requirePlatformAdmin on every /api/admin/* call regardless of what this check says.
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

  useEffect(() => {
    const shouldRefresh = hasSessionHint()
    if (!shouldRefresh) {
      setReady(true)
      return
    }
    let cancelled = false
    void refreshSession().then(async (next) => {
      if (cancelled) return
      if (!next) {
        setReady(true)
        return
      }
      const isAdmin = await confirmPlatformAdmin().catch(() => false)
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
  }, [])

  useEffect(() => {
    const sync = () => setSession(readSession())
    const unsubscribe = subscribeSession(sync)
    sync()
    return unsubscribe
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setNotAdmin(false)
    const next = await apiFetch<{ token: string; userId: string }>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    })
    const clean: Session = { token: next.token, userId: next.userId }
    // Check admin status BEFORE committing the session, so a non-admin never sees the shell even
    // for an instant. The sign-in form reports "not an administrator", never "wrong password" —
    // the credentials were correct.
    writeSession(clean)
    const isAdmin = await confirmPlatformAdmin().catch(() => false)
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

  const value = useMemo<AuthContextValue>(
    () => ({ session, isAuthenticated: session !== null, ready, notAdmin, login, logout }),
    [session, ready, notAdmin, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
