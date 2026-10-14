// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'
import type { OrgDetail } from '../src/lib/types'

// useAuth is consumed by Shell; stub it so the page renders without going through the real
// auth-context/session machinery (out of scope for this component test).
vi.mock('../src/lib/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: true, ready: true, logout: vi.fn() }),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'org_test123' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const getOrg = vi.fn()
const setPlan = vi.fn()
const grantComp = vi.fn()
const revokeComp = vi.fn()
vi.mock('../src/lib/admin-api', () => ({ getOrg, setPlan, grantComp, revokeComp }))

const baseOrg: OrgDetail = {
  id: 'org_test123',
  name: 'Acme Inc',
  slug: 'acme',
  plan: 'pro',
  planExpiresAt: null,
  memberCount: 3,
  createdAt: new Date('2026-01-01').toISOString(),
  entitlements: {
    plan: 'pro',
    maxSyncTargets: 25,
    autoRunsPerHour: 600,
    auditRetentionDays: 90,
    complianceExport: false,
    maxProjects: -1,
    maxSecrets: -1,
    maxEnvironmentsPerProject: -1,
    maxSeats: -1,
  },
  usage: { projectCount: 2, syncTargetCount: 4 },
}

async function renderPage() {
  const { default: OrgDetailPage } = await import('../src/app/orgs/[id]/page')
  return render(<OrgDetailPage />)
}

beforeEach(() => {
  getOrg.mockReset()
  setPlan.mockReset()
  grantComp.mockReset()
  revokeComp.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('org detail page', () => {
  it('loads and renders the organisation summary and entitlements', async () => {
    getOrg.mockResolvedValue(baseOrg)
    await renderPage()
    expect(await screen.findByRole('heading', { name: 'Acme Inc' })).toBeInTheDocument()
    expect(screen.getByText(/4 of 25/)).toBeInTheDocument()
  })

  it('renders a not-found empty state on a 404', async () => {
    getOrg.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'not found'))
    await renderPage()
    expect(await screen.findByText('Organisation not found')).toBeInTheDocument()
  })

  it('renders the mapped error message on a load failure other than 404', async () => {
    getOrg.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'raw'))
    await renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem. Try again shortly.')
  })

  it('set plan: cancel closes the confirm panel without calling the API and returns focus', async () => {
    getOrg.mockResolvedValue(baseOrg)
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })

    const select = screen.getByRole('combobox', { name: 'Plan' })
    await user.selectOptions(select, 'team')
    const trigger = screen.getByRole('button', { name: 'Set plan' })
    await user.click(trigger)

    const dialog = await screen.findByRole('alertdialog', { name: /Confirm setting plan to team/ })
    expect(dialog).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(setPlan).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('set plan: confirm calls setPlan with the selected plan and reloads', async () => {
    getOrg.mockResolvedValueOnce(baseOrg).mockResolvedValueOnce({ ...baseOrg, plan: 'team' })
    setPlan.mockResolvedValue({ id: baseOrg.id, plan: 'team', planExpiresAt: null })
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan' }), 'team')
    await user.click(screen.getByRole('button', { name: 'Set plan' }))
    await user.click(screen.getByRole('button', { name: 'Yes, set plan' }))

    await waitFor(() => expect(setPlan).toHaveBeenCalledWith('org_test123', 'team'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('set plan: a thrown ApiError shows the mapped message and collapses the confirm panel', async () => {
    getOrg.mockResolvedValue(baseOrg)
    setPlan.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'raw'))
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan' }), 'team')
    await user.click(screen.getByRole('button', { name: 'Set plan' }))
    await user.click(screen.getByRole('button', { name: 'Yes, set plan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('revoke comp is only offered when a comp is active, and confirming calls revokeComp', async () => {
    getOrg.mockResolvedValue({ ...baseOrg, planExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    revokeComp.mockResolvedValue({ id: baseOrg.id, plan: 'free', planExpiresAt: null })
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })

    const revokeTrigger = screen.getByRole('button', { name: 'Revoke comp' })
    await user.click(revokeTrigger)
    await user.click(screen.getByRole('button', { name: 'Yes, revoke' }))
    await waitFor(() => expect(revokeComp).toHaveBeenCalledWith('org_test123'))
  })

  it('revoke comp is not offered when there is no active comp', async () => {
    getOrg.mockResolvedValue(baseOrg) // planExpiresAt: null
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })
    expect(screen.queryByRole('button', { name: 'Revoke comp' })).not.toBeInTheDocument()
  })

  it('grant comp calls grantComp with the selected plan and days', async () => {
    getOrg.mockResolvedValue(baseOrg)
    grantComp.mockResolvedValue({ id: baseOrg.id, plan: 'team', planExpiresAt: new Date().toISOString() })
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Acme Inc' })

    const daysInput = screen.getByLabelText('Days')
    await user.clear(daysInput)
    await user.type(daysInput, '14')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Comp plan' }), 'team')
    await user.click(screen.getByRole('button', { name: 'Grant comp' }))
    await user.click(screen.getByRole('button', { name: 'Yes, grant' }))

    await waitFor(() => expect(grantComp).toHaveBeenCalledWith('org_test123', 'team', 14))
  })
})
