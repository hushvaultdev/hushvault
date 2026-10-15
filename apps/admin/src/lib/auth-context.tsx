'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { adminFetch, ApiError } from './api'

interface AuthContextValue {
  ready: boolean
  isAdmin: boolean
  notAdmin: boolean
  checkFailed: boolean
  retryCheck: () => void
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false)
  const [ready, setReady] = useState(false)
  const [notAdmin, setNotAdmin] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setCheckFailed(false)
    setNotAdmin(false)
    setIsAdmin(false)
    setReady(false)

    adminFetch('/api/admin/orgs')
      .then(() => {
        if (cancelled) return
        setIsAdmin(true)
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 403) {
          setNotAdmin(true)
        } else {
          setCheckFailed(true)
        }
        setReady(true)
      })
    return () => { cancelled = true }
  }, [tick])

  const retryCheck = useCallback(() => setTick((t) => t + 1), [])

  const signOut = useCallback(() => {
    window.location.href = 'https://n4k4r.cloudflareaccess.com/cdn-cgi/access/logout'
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ ready, isAdmin, notAdmin, checkFailed, retryCheck, signOut }),
    [ready, isAdmin, notAdmin, checkFailed, retryCheck, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
