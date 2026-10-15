// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'

const { adminFetch } = vi.hoisted(() => ({
  adminFetch: vi.fn(),
}))
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')
  return { ...actual, adminFetch }
})

async function renderProvider() {
  const { AuthProvider, useAuth } = await import('../src/lib/auth-context')
  function Probe() {
    const auth = useAuth()
    return (
      <div>
        <span data-testid="ready">{String(auth.ready)}</span>
        <span data-testid="isAdmin">{String(auth.isAdmin)}</span>
        <span data-testid="notAdmin">{String(auth.notAdmin)}</span>
        <span data-testid="notAdminReason">{auth.notAdminReason}</span>
        <span data-testid="checkFailed">{String(auth.checkFailed)}</span>
        <button onClick={auth.retryCheck}>Retry</button>
      </div>
    )
  }
  return render(<AuthProvider><Probe /></AuthProvider>)
}

beforeEach(() => {
  adminFetch.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('AuthProvider — Access-only admin check (#108 redesign)', () => {
  it('admin check succeeds: isAdmin true', async () => {
    adminFetch.mockResolvedValue([])
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('isAdmin').textContent).toBe('true')
    expect(screen.getByTestId('notAdmin').textContent).toBe('false')
    expect(screen.getByTestId('checkFailed').textContent).toBe('false')
  })

  it('a 403 from the admin check: notAdmin true with reason', async () => {
    adminFetch.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'No HushVault account found for this email. Sign up via the main app first.'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('notAdmin').textContent).toBe('true')
    expect(screen.getByTestId('notAdminReason').textContent).toBe('No HushVault account found for this email. Sign up via the main app first.')
    expect(screen.getByTestId('isAdmin').textContent).toBe('false')
    expect(screen.getByTestId('checkFailed').textContent).toBe('false')
  })

  it('a 500 from the admin check surfaces checkFailed (#111 regression)', async () => {
    adminFetch.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'oops'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('checkFailed').textContent).toBe('true')
    expect(screen.getByTestId('isAdmin').textContent).toBe('false')
    expect(screen.getByTestId('notAdmin').textContent).toBe('false')
  })

  it('a network error also surfaces checkFailed, not notAdmin', async () => {
    adminFetch.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('checkFailed').textContent).toBe('true')
    expect(screen.getByTestId('notAdmin').textContent).toBe('false')
  })

  it('retryCheck re-runs and succeeds once the API recovers', async () => {
    adminFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'oops'))
    const user = userEvent.setup()
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId('checkFailed').textContent).toBe('true'))

    adminFetch.mockResolvedValue([])
    await act(async () => { await user.click(screen.getByText('Retry')) })

    await waitFor(() => expect(screen.getByTestId('checkFailed').textContent).toBe('false'))
    expect(screen.getByTestId('isAdmin').textContent).toBe('true')
  })
})
