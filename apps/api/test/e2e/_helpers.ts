// E2E helpers for the live-dev lane. See apps/api/test/e2e/README.md (plan file) for the model:
// each test mints a throwaway user, drives the real API, then DELETEs the account to cascade.
import { randomBytes } from 'node:crypto'

export const BASE_URL = () => process.env.HUSHVAULT_E2E_BASE_URL!
export const CF_API = 'https://api.cloudflare.com/client/v4'
export const CF_ACCOUNT_ID = () => process.env.CLOUDFLARE_ACCOUNT_ID!
export const CF_TOKEN = () => process.env.CLOUDFLARE_API_TOKEN!
export const CF_SCRIPT = () => process.env.HUSHVAULT_E2E_CF_SCRIPT!

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export type ApiResult<T = unknown> = { status: number; body: T; headers: Headers }

/** Low-level request. Never throws on non-2xx — callers assert what they want. */
export async function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type') && init.json !== undefined) headers.set('content-type', 'application/json')
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  const res = await fetch(`${BASE_URL()}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  })
  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

export async function cfApi(path: string, init: RequestInit & { json?: unknown } = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${CF_TOKEN()}`)
  if (!headers.has('content-type') && init.json !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  })
  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

export type RegisteredUser = {
  runId: string
  email: string
  password: string
  token: string
  userId: string
  orgId: string
}

/**
 * Register a brand-new user with an auto-verified e2e email on dev.
 * Returns the access token + ids. Fails loudly on any non-201.
 */
export async function registerThrowawayUser(opts: { runId?: string; orgName?: string } = {}): Promise<RegisteredUser> {
  const runId = opts.runId ?? makeRunId()
  const email = `e2e+e2e-${runId}@hushvault.test`
  const password = `E2E_${randomBytes(16).toString('base64url')}_pw`
  const organisationName = opts.orgName ?? `e2e-org-${runId}`
  const res = await api('/api/auth/register', {
    method: 'POST',
    json: { email, password, organisationName },
  })
  if (res.status !== 201) {
    throw new Error(`register failed: HTTP ${res.status} ${JSON.stringify(res.body)}`)
  }
  const data = (res.body as { data: { userId: string; orgId: string; token: string; emailVerified: boolean } }).data
  if (!data.emailVerified) {
    throw new Error(`register unexpectedly returned emailVerified=false — is this dev with the auto-verify tag path deployed?`)
  }
  return { runId, email, password, token: data.token, userId: data.userId, orgId: data.orgId }
}

/** DELETE /api/auth/account — cascades through orgs the user solely owns. Idempotent-ish; a 404 is fine. */
export async function teardownAccount(token: string, password: string): Promise<void> {
  const res = await api('/api/auth/account', {
    method: 'DELETE',
    token,
    json: { password },
  })
  if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
    // Don't throw — teardown runs in afterAll. Log so the test still fails informatively.
    console.warn(`teardownAccount: unexpected status ${res.status}: ${JSON.stringify(res.body)}`)
  }
}

/** Create project+env; returns ids. */
export async function createProjectAndEnv(token: string, runId: string): Promise<{ projectId: string; envId: string }> {
  const p = await api('/api/projects', {
    method: 'POST',
    token,
    json: { name: `e2e-prj-${runId}`, description: 'e2e' },
  })
  if (p.status !== 201 && p.status !== 200) throw new Error(`create project: ${p.status} ${JSON.stringify(p.body)}`)
  const projectId = (p.body as { data: { id: string } }).data.id
  const e = await api('/api/environments', {
    method: 'POST',
    token,
    json: { projectId, name: `e2e-env-${runId}` },
  })
  if (e.status !== 201 && e.status !== 200) throw new Error(`create env: ${e.status} ${JSON.stringify(e.body)}`)
  const envId = (e.body as { data: { id: string } }).data.id
  return { projectId, envId }
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000
  const interval = opts.intervalMs ?? 1_000
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`waitFor: timed out after ${timeout}ms`)
    await new Promise((r) => setTimeout(r, interval))
  }
}
