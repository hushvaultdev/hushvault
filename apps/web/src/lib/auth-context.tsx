'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { apiFetch } from './api'
import { clearSession, readSession, writeSession } from './auth-storage'
import type { Session } from './types'

interface AuthContextValue {
  session: Session | null
  isAuthenticated: boolean
  // True until the stored session has been read on the client (avoids SSR/CSR flicker).
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, organisationName: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setSession(readSession())
    setReady(true)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const next = await apiFetch<Session>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    })
    writeSession(next)
    setSession(next)
  }, [])

  const register = useCallback(async (email: string, password: string, organisationName: string) => {
    const result = await apiFetch<{ userId: string; orgId: string; token: string }>('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: { email, password, organisationName },
    })
    const next: Session = { ...result, role: 'owner' }
    writeSession(next)
    setSession(next)
  }, [])

  const logout = useCallback(() => {
    clearSession()
    setSession(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ session, isAuthenticated: Boolean(session), ready, login, register, logout }),
    [session, ready, login, register, logout],
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
