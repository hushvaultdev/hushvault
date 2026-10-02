'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { apiFetch, endSession, refreshSession } from './api'
import { clearSession, hasSessionHint, markSessionHint, purgeLegacyStorage, readSession, writeSession } from './auth-storage'
import type { Session } from './types'

interface AuthContextValue {
  session: Session | null
  isAuthenticated: boolean
  // True until the stored session has been read on the client (avoids SSR/CSR flicker).
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, organisationName: string) => Promise<void>
  // Adopt a session obtained out-of-band (e.g. the OAuth callback redirect).
  applySession: (session: Session) => void
  // Adopt the verified state after the user confirms their email in this browser.
  markEmailVerified: () => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // A page load has no access token in memory: trade the HttpOnly refresh cookie for one.
    // The OAuth callback adopts its own session, so skip the exchange there.
    purgeLegacyStorage()
    if (window.location.pathname.startsWith('/auth/callback') || !hasSessionHint()) {
      setReady(true)
      return
    }
    let cancelled = false
    void refreshSession().then((next) => {
      if (cancelled) return
      setSession(next)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const next = await apiFetch<Session>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    })
    const clean: Session = { token: next.token, userId: next.userId, orgId: next.orgId, role: next.role, emailVerified: next.emailVerified }
    writeSession(clean)
    markSessionHint(true)
    setSession(clean)
  }, [])

  const register = useCallback(async (email: string, password: string, organisationName: string) => {
    const result = await apiFetch<{ userId: string; orgId: string; token: string; emailVerified: boolean }>('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: { email, password, organisationName },
    })
    const next: Session = { token: result.token, userId: result.userId, orgId: result.orgId, role: 'owner', emailVerified: result.emailVerified }
    writeSession(next)
    markSessionHint(true)
    setSession(next)
  }, [])

  const applySession = useCallback((next: Session) => {
    writeSession(next)
    markSessionHint(true)
    setSession(next)
  }, [])

  const markEmailVerified = useCallback(() => {
    const current = readSession()
    if (!current) return
    const next = { ...current, emailVerified: true }
    writeSession(next)
    setSession(next)
  }, [])

  const logout = useCallback(() => {
    clearSession()
    setSession(null)
    void endSession()
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ session, isAuthenticated: Boolean(session), ready, login, register, applySession, markEmailVerified, logout }),
    [session, ready, login, register, applySession, markEmailVerified, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
