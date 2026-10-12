// GitLab CI/CD variables provider (issue #99). Pushes HushVault secrets to a gitlab.com project's
// project-level CI/CD variables, one way. Calls ONE fixed host (gitlab.com); user input only ever becomes a
// numeric project id path segment, a URL-encoded variable key, or a URL-encoded environment_scope query value,
// each validated by a strict regex first. Never logs or returns the credential, secret values or provider bodies.
//
// Scope model: one sync target maps one HushVault environment to one GitLab project + ONE environment_scope
// (default `*`). The provider scopes listNames/create/update/delete to that single scope, so within a target
// variable keys are unique and the flat (target_id, name) ledger never collides (issue #99 scoped identity).
//
// API verified against the GitLab primary docs (2026-10-12, doc/api/project_level_variables.md):
//   List   GET    /projects/:id/variables           (offset pagination: page, per_page; X-Next-Page header)
//   Create POST   /projects/:id/variables           (required key, value)
//   Update PUT    /projects/:id/variables/:key       (disambiguate scope with filter[environment_scope])
//   Delete DELETE /projects/:id/variables/:key       (disambiguate scope with filter[environment_scope])
// A variable key may contain only A-Z a-z 0-9 _ and is at most 255 chars. Managing project variables requires the
// Maintainer role, so a successful list is read-only proof that the token can write (verify / per-run).
// NOT verified from primary docs and therefore NOT pre-validated here: GitLab's masked-value content rules
// (minimum length / allowed characters). They are version-dependent and server-enforced, so a rejected masked
// value surfaces as the provider's own PROVIDER_VALIDATION rather than a guessed client-side rule (issue #99).
// Every write sets raw=true so a value containing `$...` is stored literally and never expanded by GitLab.
//
// Registered but NOT promoted: registry status stays `planned` until a live e2e against a real gitlab.com project
// is recorded on issue #99 (promotionEvidence gate). Self-managed GitLab base URLs are out of scope (SSRF).
import type { VerifyResult } from '../provider'
import type { FailureInfo, ItemResult, ProviderErrorCode, PushInput, PushResult, SyncOp, SyncProvider } from '../sync-types'

export const GITLAB_API_BASE = 'https://gitlab.com/api/v4'
export const GITLAB_PROVIDER_ID = 'gitlab'
/** GitLab list pages are offset-based; bound the work and fail closed if a target's scope spans more pages. */
export const GITLAB_LIST_PER_PAGE = 100
export const GITLAB_LIST_MAX_PAGES = 20

// A GitLab numeric project id. Only numeric ids are accepted (a URL-encoded path would widen the attack surface).
// A GitLab numeric project OR group id. Only numeric ids are accepted (a URL-encoded path would widen the attack surface).
const NUMERIC_ID = /^[1-9][0-9]{0,18}$/
// A CI/CD variable key: A-Z a-z 0-9 _ only, 1..255 chars (GitLab's documented rule).
const VARIABLE_KEY = /^[A-Za-z0-9_]{1,255}$/
// An environment_scope: a conservative subset of what GitLab accepts (names, wildcards, slashes). Never a URL.
const ENV_SCOPE = /^[A-Za-z0-9_*/.\- ]{1,255}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const enc = encodeURIComponent

type Failure = { code: ProviderErrorCode } & FailureInfo

/** Retry-After as whole seconds (delta-seconds or an HTTP date). Absent or unusable -> undefined. Capped at 24 h. */
export function parseRetryAfter(res: Response, nowMs: number = Date.now()): number | undefined {
  const raw = res.headers.get('retry-after')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  let seconds: number
  if (/^\d{1,9}$/.test(trimmed)) seconds = Number(trimmed)
  else {
    const at = Date.parse(trimmed)
    if (Number.isNaN(at)) return undefined
    seconds = Math.ceil((at - nowMs) / 1000)
  }
  return seconds > 0 ? Math.min(seconds, 86_400) : undefined
}

/** Map an HTTP status to a fixed provider code. Bodies are never persisted. A 5xx may have applied the change. */
function mapStatus(res: Response): Failure {
  switch (res.status) {
    case 401:
    case 403: return { code: 'PROVIDER_AUTH' }
    case 404: return { code: 'TARGET_NOT_FOUND' }
    case 429: {
      const retryAfterSeconds = parseRetryAfter(res)
      return retryAfterSeconds !== undefined ? { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds } : { code: 'PROVIDER_RATE_LIMIT' }
    }
    case 400:
    case 409:
    case 422: return { code: 'PROVIDER_VALIDATION' }
    case 500:
    case 502:
    case 503:
    case 504: return { code: 'PROVIDER_ERROR', maybeApplied: true }
    default: return { code: 'PROVIDER_ERROR' }
  }
}

type Fetched = { ok: true; res: Response } | ({ ok: false } & Failure)

async function glFetch(method: string, path: string, credential: string, signal: AbortSignal, body?: unknown): Promise<Fetched> {
  try {
    const res = await fetch(`${GITLAB_API_BASE}${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': credential,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal,
    })
    return { ok: true, res }
  } catch {
    // The request may have reached GitLab and been applied before the connection or the timer failed.
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', maybeApplied: true }
  }
}

/**
 * True when a 404 body says the VARIABLE (not the project) is missing. Used only for control flow (update -> create
 * fallback and idempotent delete); the body is read transiently and never stored or logged.
 */
async function isVariableNotFound(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json()
    const message = isRecord(body) && typeof body['message'] === 'string' ? body['message'] : ''
    return /variable/i.test(message) && !/project/i.test(message)
  } catch {
    return false
  }
}

// A target is EITHER a project or a group (its variables live at a different path): exactly one of projectId /
// groupId is set. The shape echoes its own input keys so a stored resource re-parses identically (idempotent).
// environment_scope on a GROUP's variables is a GitLab Premium/Ultimate feature; on Free-tier groups it is
// effectively `*` (GitLab is the authority).
type GitlabResource = { projectId?: string; groupId?: string; environmentScope: string; masked: boolean; protected: boolean }

/**
 * Validate and normalise a resource, or null when invalid. Used both at the API boundary (`parseResource`, where
 * its GitlabResource widens to SyncResourceSpec) and when a stored resource is read back for listNames/push, so a
 * corrupted `resource_json` can never reach a request. The output echoes the input key shape (projectId OR groupId)
 * with defaults filled, so re-parsing a stored resource yields the same object. Exactly one of projectId / groupId
 * (a numeric id) is required.
 */
function parseResource(resource: unknown): GitlabResource | null {
  if (!isRecord(resource)) return null
  const allowed = new Set(['projectId', 'groupId', 'environmentScope', 'masked', 'protected'])
  for (const key of Object.keys(resource)) if (!allowed.has(key)) return null
  const projectId = resource['projectId']
  const groupId = resource['groupId']
  const hasProject = projectId !== undefined
  const hasGroup = groupId !== undefined
  if (hasProject === hasGroup) return null // exactly one of projectId / groupId
  const rawId = hasProject ? projectId : groupId
  if (typeof rawId !== 'string' || !NUMERIC_ID.test(rawId)) return null
  const out: GitlabResource = hasProject ? { projectId: rawId } as GitlabResource : { groupId: rawId } as GitlabResource
  out.environmentScope = '*'
  out.masked = false
  out.protected = false
  const scope = resource['environmentScope']
  if (scope !== undefined) {
    if (typeof scope !== 'string' || !ENV_SCOPE.test(scope)) return null
    out.environmentScope = scope
  }
  for (const flag of ['masked', 'protected'] as const) {
    const v = resource[flag]
    if (v !== undefined) {
      if (typeof v !== 'boolean') return null
      out[flag] = v
    }
  }
  return out
}

function variablesPath(res: GitlabResource): string {
  return res.groupId !== undefined ? `/groups/${enc(res.groupId)}/variables` : `/projects/${enc(res.projectId ?? '')}/variables`
}

function scopeQuery(scope: string): string {
  return `filter%5Benvironment_scope%5D=${enc(scope)}`
}

/** A single create/update. Tries update first (steady state), falling back to create when the variable is absent. */
async function putOrPost(res: GitlabResource, op: Extract<SyncOp, { type: 'set' }>, credential: string, signal: AbortSignal): Promise<Failure | null> {
  const common = { value: op.value, environment_scope: res.environmentScope, masked: res.masked, protected: res.protected, raw: true }
  const put = await glFetch('PUT', `${variablesPath(res)}/${enc(op.name)}?${scopeQuery(res.environmentScope)}`, credential, signal, common)
  if (!put.ok) return { code: put.code, ...(put.maybeApplied ? { maybeApplied: true } : {}) }
  if (put.res.ok) return null
  if (put.res.status === 404 && (await isVariableNotFound(put.res))) {
    const post = await glFetch('POST', variablesPath(res), credential, signal, { key: op.name, ...common })
    if (!post.ok) return { code: post.code, ...(post.maybeApplied ? { maybeApplied: true } : {}) }
    return post.res.ok ? null : mapStatus(post.res)
  }
  return mapStatus(put.res)
}

/** A single delete. A 404 (variable already gone) is success: deletes are idempotent. */
async function deleteOne(res: GitlabResource, name: string, credential: string, signal: AbortSignal): Promise<Failure | null> {
  const del = await glFetch('DELETE', `${variablesPath(res)}/${enc(name)}?${scopeQuery(res.environmentScope)}`, credential, signal)
  if (!del.ok) return { code: del.code, ...(del.maybeApplied ? { maybeApplied: true } : {}) }
  if (del.res.ok || del.res.status === 404) return null
  return mapStatus(del.res)
}

export const gitlabProvider: SyncProvider = {
  id: GITLAB_PROVIDER_ID,
  // No bulk endpoint: each op is one (sometimes two) sequential requests, so chunk small and allow a longer push
  // window than the bulk default. maxItems/maxValueBytes are conservative capacity guards; GitLab is the final
  // authority on value size and masked content.
  limits: { maxItems: 200, maxNameLength: 255, maxValueBytes: 10 * 1024, maxOpsPerChunk: 20, listTimeoutMs: 20_000, pushTimeoutMs: 60_000 },

  validateName(name) {
    return VARIABLE_KEY.test(name)
  },

  // Suggest a GitLab-valid key for a name GitLab would reject, WITHOUT changing case (GitLab keys allow a-z and a
  // leading digit, so only the disallowed characters need fixing). Returns null when it is already valid or nothing
  // sensible remains. The engine only surfaces this as a hint; it never renames on its own.
  suggestName(name) {
    if (VARIABLE_KEY.test(name)) return null
    const cleaned = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 255)
    return cleaned.length > 0 && VARIABLE_KEY.test(cleaned) && cleaned !== name ? cleaned : null
  },

  parseConfig(config) {
    // The connection is just the access token; there is no non-secret config. Reject anything else (no base URL).
    if (!isRecord(config) || Object.keys(config).length !== 0) return null
    return {}
  },

  parseResource,

  async verify(credential, _config, signal): Promise<VerifyResult> {
    // Token liveness only: the connection names no project yet. Per-project write scope is proved when a target is
    // previewed or run (listNames below needs the Maintainer role, so it 403s for an under-privileged token).
    const fetched = await glFetch('GET', '/projects?membership=true&per_page=1', credential, signal)
    if (!fetched.ok) return { ok: false, code: 'PROVIDER_ERROR' }
    const { res } = fetched
    if (res.status === 429) return { ok: false, code: 'PROVIDER_RATE_LIMIT' }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'PROVIDER_AUTH' }
    return res.ok ? { ok: true } : { ok: false, code: 'PROVIDER_ERROR' }
  },

  async listNames(input) {
    const res = parseResource(input.resource)
    if (!res) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const names: string[] = []
    // Offset pagination; keep only this target's environment_scope. Fail closed if the scope spans more than the
    // bounded number of pages (planning against a truncated list would misclassify names as missing or as ours).
    for (let page = 1; page <= GITLAB_LIST_MAX_PAGES; page += 1) {
      const fetched = await glFetch('GET', `${variablesPath(res)}?per_page=${GITLAB_LIST_PER_PAGE}&page=${page}`, input.credential, input.signal)
      if (!fetched.ok) return { ok: false, code: fetched.code }
      if (!fetched.res.ok) {
        const f = mapStatus(fetched.res)
        return { ok: false, code: f.code, ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}) }
      }
      let items: unknown
      try {
        items = await fetched.res.json()
      } catch {
        return { ok: false, code: 'PROVIDER_ERROR' }
      }
      if (!Array.isArray(items)) return { ok: false, code: 'PROVIDER_ERROR' }
      for (const item of items) {
        if (isRecord(item) && typeof item['key'] === 'string' && item['environment_scope'] === res.environmentScope) names.push(item['key'])
      }
      const next = fetched.res.headers.get('x-next-page')
      if (next === null || next === '') return { ok: true, names }
      if (page === GITLAB_LIST_MAX_PAGES) return { ok: false, code: 'PROVIDER_ERROR' } // more pages than we will read: fail closed
    }
    return { ok: false, code: 'PROVIDER_ERROR' }
  },

  async push(input: PushInput): Promise<PushResult> {
    const res = parseResource(input.resource)
    if (!res) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const results: ItemResult[] = []
    let stop: Failure | null = null
    for (const op of input.ops) {
      if (stop) {
        results.push({ name: op.name, ok: false, code: stop.code })
        continue
      }
      const failure = op.type === 'set'
        ? await putOrPost(res, op, input.credential, input.signal)
        : await deleteOne(res, op.name, input.credential, input.signal)
      results.push(failure ? { name: op.name, ok: false, ...failure } : { name: op.name, ok: true })
      // Stop the rest of the batch on a failure that will not improve within this run (auth, missing project, rate
      // limit, timeout). A per-variable validation error does not stop the others.
      if (failure && failure.code !== 'PROVIDER_VALIDATION' && failure.code !== 'PROVIDER_ERROR') stop = failure
    }
    return { ok: true, results }
  },
}
