/**
 * Small typed HushVault API client. Uses global fetch (looked up at call time
 * so tests can stub it), unwraps `{data}` envelopes and throws ApiError.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Structured extra from the error body (only `plan` on SYNC_BLOCKED); callers must treat it as untrusted. */
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ProjectRow {
  id: string
  name: string
  slug: string
  description?: string | null
  created_at?: string
  updated_at?: string
}

export interface EnvironmentRow {
  id: string
  project_id: string
  name: string
  slug: string
  parent_env_id: string | null
  color?: string | null
  created_at?: string
}

export interface SecretMetaRow {
  id: string
  project_id: string
  env_id: string
  name: string
  is_computed: number | boolean
  template: string | null
  created_at?: string
  updated_at?: string
}

export interface ResolvedSecret {
  id: string
  name: string
  isComputed: boolean
  template: string | null
  inheritedFrom: string | null
  value: string | null
}

export interface ResolvedEnvironment {
  environmentId: string
  values: boolean
  secrets: ResolvedSecret[]
}

export interface LoginResult {
  token: string
  userId: string
  orgId: string
  role: string
  /** Present because the CLI identifies itself with X-HushVault-Client: cli. */
  refreshToken?: string
}

export interface ShareResult {
  token: string
  url: string
}

// Sync DTOs mirror the contract in packages/shared/src/integrations.ts (SyncTargetDto, SyncPlanDto,
// SyncRunDto). The CLI does not depend on @hushvault/shared, so the field names are copied here.
// They carry names and counts only: never secret values or provider credentials.
export type SyncRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'

export interface SyncTarget {
  id: string
  projectId: string
  envId: string
  connectionId: string
  provider: string
  resource: Record<string, string>
  nameFilter: { prefix?: string; deny?: string[] }
  deleteRemoved: boolean
  status: 'active' | 'needs_attention'
  lastRunAt: string | null
  lastRunStatus: SyncRunStatus | null
}

export interface SyncPlan {
  create: string[]
  update: string[]
  delete: string[]
  skip: string[]
  conflict: string[]
  blockers: { code: string; names: string[] }[]
}

export interface SyncRun {
  id: string
  targetId: string
  trigger: string
  status: SyncRunStatus
  attempt: number
  counts: { created: number; updated: number; deleted: number; skipped: number; failed: number }
  errorCode: string | null
  startedAt: string
  finishedAt: string | null
  nextRetryAt: string | null
}

export interface ClientOptions {
  apiUrl: string
  token?: string | undefined
  /** Called once on a 401 for a keychain session; returns a fresh access token or null. */
  refresh?: (() => Promise<string | null>) | undefined
}

type Query = Record<string, string | undefined>

const MAX_MESSAGE = 300

function normalizeApiUrl(apiUrl: string): string {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new ApiError(0, 'INVALID_API_URL', `Invalid API URL: ${apiUrl}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ApiError(0, 'INSECURE_API_URL', 'API URL must use https (http is only allowed for localhost)')
  }
  return url.toString().replace(/\/+$/, '')
}

export class ApiClient {
  private readonly baseUrl: string
  private token: string | undefined
  private readonly refreshHook: (() => Promise<string | null>) | undefined

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeApiUrl(options.apiUrl)
    this.token = options.token
    this.refreshHook = options.refresh
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}, retried = false): Promise<T> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) qs.set(k, v)
    }
    const url = `${this.baseUrl}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`

    // 'cli' makes the API return the refresh token in the body (browsers get an HttpOnly cookie instead).
    const headers: Record<string, string> = { Accept: 'application/json', 'X-HushVault-Client': 'cli' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }

    let res: Response
    try {
      res = await fetch(url, init)
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', `Could not reach ${this.baseUrl}. Check your connection and API URL.`)
    }

    let json: unknown = undefined
    try {
      json = await res.json()
    } catch {
      json = undefined
    }

    if (res.status === 401 && this.token && this.refreshHook && !retried) {
      const fresh = await this.refreshHook()
      if (fresh) {
        this.token = fresh
        return this.request<T>(method, path, opts, true)
      }
    }

    if (!res.ok) {
      // Only the API's own `error` / `message` fields are surfaced, never the raw body.
      const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
      const code = typeof obj['error'] === 'string' ? obj['error'] : `HTTP_${res.status}`
      const message =
        typeof obj['message'] === 'string' ? obj['message'].slice(0, MAX_MESSAGE) : res.statusText || `Request failed (${res.status})`
      throw new ApiError(res.status, code, message, code === 'SYNC_BLOCKED' ? obj['plan'] : undefined)
    }

    if (typeof json !== 'object' || json === null || !('data' in json)) {
      throw new ApiError(res.status, 'BAD_RESPONSE', 'Unexpected response from server')
    }
    return (json as { data: T }).data
  }

  /** API keys (hv_...) cannot manage integrations; the API answers 403 for them. */
  get usesApiKey(): boolean {
    return this.token?.startsWith('hv_') === true
  }

  login(email: string, password: string): Promise<LoginResult> {
    return this.request('POST', '/api/auth/login', { body: { email, password } })
  }

  /** Rotate a refresh token. Sent in the body (never a cookie), so no CSRF surface. */
  refreshSession(refreshToken: string): Promise<LoginResult> {
    return this.request('POST', '/api/auth/refresh', { body: { refreshToken } }, true)
  }

  listProjects(): Promise<ProjectRow[]> {
    return this.request('GET', '/api/projects')
  }

  createProject(input: { name: string; slug?: string; description?: string }): Promise<{ id: string; name: string; slug: string }> {
    return this.request('POST', '/api/projects', { body: input })
  }

  listEnvironments(projectId: string): Promise<EnvironmentRow[]> {
    return this.request('GET', '/api/environments', { query: { projectId } })
  }

  createEnvironment(input: { projectId: string; name: string; slug?: string; parentEnvId?: string }): Promise<{ id: string; name: string; slug: string }> {
    return this.request('POST', '/api/environments', { body: input })
  }

  listSecrets(projectId: string, envId: string): Promise<SecretMetaRow[]> {
    return this.request('GET', '/api/secrets', { query: { projectId, envId } })
  }

  createSecret(input: { projectId: string; envId: string; name: string; value: string }): Promise<{ id: string; name: string }> {
    return this.request('POST', '/api/secrets', { body: input })
  }

  updateSecret(id: string, input: { value?: string; name?: string }): Promise<{ id: string; name: string }> {
    return this.request('PATCH', `/api/secrets/${encodeURIComponent(id)}`, { body: input })
  }

  getResolved(envId: string): Promise<ResolvedEnvironment> {
    return this.request('GET', `/api/environments/${encodeURIComponent(envId)}/resolved`, { query: { values: 'true' } })
  }

  listTargets(): Promise<SyncTarget[]> {
    return this.request('GET', '/api/integrations/targets')
  }

  previewTarget(id: string): Promise<SyncPlan> {
    return this.request('POST', `/api/integrations/targets/${encodeURIComponent(id)}/preview`)
  }

  runTarget(id: string): Promise<SyncRun> {
    return this.request('POST', `/api/integrations/targets/${encodeURIComponent(id)}/run`)
  }

  listRuns(id: string): Promise<SyncRun[]> {
    return this.request('GET', `/api/integrations/targets/${encodeURIComponent(id)}/runs`)
  }

  createShare(input: { encryptedPayload: string; expiresAt?: string; maxViews?: number }): Promise<ShareResult> {
    return this.request('POST', '/api/share', { body: input })
  }
}

/** Turn any error into a short, user-facing message (never includes secret values). */
export function friendlyError(err: unknown, action = 'Request'): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return 'Authentication failed. Run `hushvault login` or check HUSHVAULT_TOKEN.'
      case 403:
        return `Permission denied: ${action} requires a higher role (member+ for secrets, admin+ for projects/environments).`
      case 409:
        if (err.code === 'PLAN_LIMIT') {
          return 'Plan limit reached: the Free plan allows at most 2 sync targets per organisation. Remove a target or upgrade in the dashboard.'
        }
        return `Conflict: ${err.message}`
      case 400:
        return `Invalid input: ${err.message}`
      case 429:
        return 'Rate limited: too many sync requests. Wait a minute and try again.'
      case 422:
        if (err.code === 'SYNC_BLOCKED') return 'Sync blocked: the plan cannot run until the listed problems are fixed (SYNC_BLOCKED).'
        return `${err.message} (${err.code})`
      default:
        return err.message
    }
  }
  return err instanceof Error ? err.message : 'Unknown error'
}
