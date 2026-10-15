// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'

// Mocked before importing the module under test so the hooks pick up the fakes.
// vi.hoisted is used so the mock factory (which is itself hoisted to the top of the file) can
// close over fresh vi.fn() instances that this test's beforeEach can reset.
const { apiFetch, refreshSession, endSession } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refreshSession: vi.fn(),
  endSession: vi.fn(),
}))
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')
  return { ...actual, apiFetch, refreshSession, endSession }
})

// Session store: a thin in-memory fake. Keeping real localStorage/jsdom plumbing out of this test
// so the assertions are about the auth logic, not the store contract (that's session-store.test.ts).
const state = vi.hoisted(() => ({ storedSession: null as { token: string; userId: string } | null, hintPresent: false }))
vi.mock('../src/lib/auth-storage', () => {
  const store = {
    read: () => state.storedSession,
    write: (s: typeof state.storedSession) => { state.storedSession = s },
    clear: () => { state.storedSession = null },
    subscribe: () => () => undefined,
    hasHint: () => state.hintPresent,
    markHint: (p: boolean) => { state.hintPresent = p },
    hintKey: 'hv_admin_has_session',
  }
  return {
    sessionStore: store,
    readSession: store.read,
    writeSession: store.write,
    clearSession: store.clear,
    subscribeSession: store.subscribe,
    hasSessionHint: store.hasHint,
    markSessionHint: store.markHint,
  }
})

async function renderProvider() {
  const { AuthProvider, useAuth } = await import('../src/lib/auth-context')
  function Probe() {
    const auth = useAuth()
    return (
      <div>
        <span data-testid="ready">{String(auth.ready)}</span>
        <span data-testid="auth">{String(auth.isAuthenticated)}</span>
        <span data-testid="notAdmin">{String(auth.notAdmin)}</span>
        <span data-testid="checkFailed">{String(auth.checkFailed)}</span>
        <button onClick={auth.retryCheck}>Retry</button>
      </div>
    )
  }
  return render(<AuthProvider><Probe /></AuthProvider>)
}

beforeEach(() => {
  apiFetch.mockReset()
  refreshSession.mockReset()
  endSession.mockReset()
  state.storedSession = null
  state.hintPresent = false
})

afterEach(() => {
  cleanup()
})

describe('AuthProvider — cold-load admin check (#111)', () => {
  it('no session hint: becomes ready without calling refresh or admin-check', async () => {
    await renderProvider()
    await screen.findByText('true', { selector: '[data-testid="ready"]' as never })
    expect(refreshSession).not.toHaveBeenCalled()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('session restores and admin check succeeds: isAuthenticated true, no error states', async () => {
    state.hintPresent = true
    refreshSession.mockResolvedValue({ token: 't', userId: 'u' })
    apiFetch.mockResolvedValue([]) // GET /api/admin/orgs happy path
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('auth').textContent).toBe('true')
    expect(screen.getByTestId('notAdmin').textContent).toBe('false')
    expect(screen.getByTestId('checkFailed').textContent).toBe('false')
  })

  it('a 403 from the admin check: session cleared, notAdmin true (not checkFailed)', async () => {
    state.hintPresent = true
    refreshSession.mockResolvedValue({ token: 't', userId: 'u' })
    apiFetch.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'forbidden'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('notAdmin').textContent).toBe('true')
    expect(screen.getByTestId('auth').textContent).toBe('false')
    expect(screen.getByTestId('checkFailed').textContent).toBe('false')
  })

  it('a 500 from the admin check keeps the session and surfaces checkFailed (#111 regression)', async () => {
    state.hintPresent = true
    // Prime the stored session so we can assert it is NOT cleared by the mount-time failure path.
    state.storedSession = { token: 't-existing', userId: 'u' }
    refreshSession.mockResolvedValue({ token: 't', userId: 'u' })
    apiFetch.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'oops'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('checkFailed').textContent).toBe('true')
    expect(screen.getByTestId('auth').textContent).toBe('true') // session intact
    expect(screen.getByTestId('notAdmin').textContent).toBe('false') // NOT falsely flagged
    expect(state.storedSession).not.toBeNull() // session NOT cleared (pre-#111 bug would clear it)
    expect(state.hintPresent).toBe(true) // hint NOT cleared (pre-#111 bug would clear it)
  })

  it('a network error (ApiError status 0) also surfaces checkFailed, not notAdmin', async () => {
    state.hintPresent = true
    refreshSession.mockResolvedValue({ token: 't', userId: 'u' })
    apiFetch.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('checkFailed').textContent).toBe('true')
    expect(screen.getByTestId('notAdmin').textContent).toBe('false')
  })

  it('retryCheck re-runs the restore and succeeds once the API recovers', async () => {
    state.hintPresent = true
    refreshSession.mockResolvedValue({ token: 't', userId: 'u' })
    apiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'oops'))
    const user = userEvent.setup()
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('checkFailed').textContent).toBe('true'))

    apiFetch.mockResolvedValue([]) // API recovers
    await act(async () => { await user.click(screen.getByText('Retry')) })

    await waitFor(() => expect(screen.getByTestId('checkFailed').textContent).toBe('false'))
    expect(screen.getByTestId('auth').textContent).toBe('true')
  })
})
