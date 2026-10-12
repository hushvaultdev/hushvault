// GitHub Actions repository secrets provider (issue #44). Pushes HushVault secrets to a repository's Actions
// secrets, one way. Calls ONE fixed host (api.github.com); user input only ever becomes URL-encoded owner/repo
// path segments and a URL-encoded secret name, each validated by a strict regex first. Never logs or returns the
// credential, secret values or provider bodies.
//
// GitHub requires each value sealed as a libsodium crypto_box_seal against the repo public key. That sealing is
// the single owner-approved exception to "WebCrypto only" and lives in ./github-seal.ts; this module only calls it.
//
// API verified from GitHub docs (2026-10-12):
//   Public key GET  /repos/{owner}/{repo}/actions/secrets/public-key   -> { key_id, key }  (fetched once per run)
//   Upsert     PUT  /repos/{owner}/{repo}/actions/secrets/{name}        body { encrypted_value, key_id }  201/204
//   Delete     DELETE /repos/{owner}/{repo}/actions/secrets/{name}      204 (404 == already gone)
//   List       GET  /repos/{owner}/{repo}/actions/secrets               { total_count, secrets: [{ name }] }
// Secret names: alphanumeric or underscore, must not start with a number or the GITHUB_ prefix; case-insensitive,
// stored uppercase. Limits: 100 repo secrets, 48 KB each. v1 does repository secrets only (environment secrets are
// a follow-up). Credential: a fine-grained PAT with the repository "Secrets" write permission. Self-hosted GitHub
// Enterprise is out of scope (fixed host, SSRF).
import type { VerifyResult } from '../provider'
import type { FailureInfo, ItemResult, ProviderErrorCode, PushInput, PushResult, SyncProvider } from '../sync-types'
import { sealForGitHub } from './github-seal'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_ACTIONS_PROVIDER_ID = 'github-actions'
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_LIST_PER_PAGE = 100
export const GITHUB_LIST_MAX_PAGES = 20

// owner: 1..39 chars, alphanumeric or single hyphens, no leading/trailing hyphen. repo: 1..100 of [A-Za-z0-9._-].
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
// A secret name: letters/digits/underscore, not starting with a digit, not starting with GITHUB_ (case-insensitive).
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const enc = encodeURIComponent

type Failure = { code: ProviderErrorCode } & FailureInfo
type GithubResource = { owner: string; repo: string }
type GithubSession = { keyId: string; key: string }

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

function mapStatus(res: Response): Failure {
  switch (res.status) {
    case 401:
    case 403: {
      // GitHub returns 403 with a Retry-After or x-ratelimit-remaining:0 for secondary/ primary rate limits.
      if (res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0') {
        const retryAfterSeconds = parseRetryAfter(res)
        return retryAfterSeconds !== undefined ? { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds } : { code: 'PROVIDER_RATE_LIMIT' }
      }
      return { code: 'PROVIDER_AUTH' }
    }
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

async function ghFetch(method: string, path: string, credential: string, signal: AbortSignal, body?: unknown): Promise<Fetched> {
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': 'HushVault-Sync',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal,
    })
    return { ok: true, res }
  } catch {
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', maybeApplied: true }
  }
}

function parseResource(resource: unknown): GithubResource | null {
  if (!isRecord(resource)) return null
  const keys = Object.keys(resource)
  if (keys.length !== 2 || !keys.includes('owner') || !keys.includes('repo')) return null
  const owner = resource['owner']
  const repo = resource['repo']
  if (typeof owner !== 'string' || !OWNER.test(owner)) return null
  if (typeof repo !== 'string' || !REPO.test(repo)) return null
  return { owner, repo }
}

function secretsBase(res: GithubResource): string {
  return `/repos/${enc(res.owner)}/${enc(res.repo)}/actions/secrets`
}

export const githubActionsProvider: SyncProvider = {
  id: GITHUB_ACTIONS_PROVIDER_ID,
  // No bulk endpoint, and each set seals + PUTs: chunk small, allow a longer push window. 100 secrets / 48 KB each.
  limits: { maxItems: 100, maxNameLength: 100, maxValueBytes: 48 * 1024, maxOpsPerChunk: 20, listTimeoutMs: 20_000, pushTimeoutMs: 60_000 },

  validateName(name) {
    return name.length <= 100 && SECRET_NAME.test(name) && !/^GITHUB_/i.test(name)
  },

  // Suggest a GitHub-valid name for a rejected one: uppercase (GitHub stores secrets uppercase), non-[A-Za-z0-9_]
  // runs -> _, strip a leading GITHUB_, and prefix _ if it would start with a digit. Null when already valid or
  // nothing sensible remains. Hint only — the engine never renames.
  suggestName(name) {
    if (this.validateName!(name)) return null
    let s = name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    s = s.replace(/^GITHUB_+/, '')
    if (/^[0-9]/.test(s)) s = `_${s}`
    s = s.slice(0, 100)
    return s.length > 0 && this.validateName!(s) && s !== name ? s : null
  },

  parseConfig(config) {
    // The connection is just the token; no non-secret config (no base URL — fixed host).
    if (!isRecord(config) || Object.keys(config).length !== 0) return null
    return {}
  },

  parseResource,

  async verify(credential, _config, signal): Promise<VerifyResult> {
    // Token liveness only (the connection names no repo yet). Per-repo write scope is proved by prepare()/push,
    // which need the repo's public key and the Secrets write permission.
    const fetched = await ghFetch('GET', '/rate_limit', credential, signal)
    if (!fetched.ok) return { ok: false, code: 'PROVIDER_ERROR' }
    const { res } = fetched
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'PROVIDER_AUTH' }
    return res.ok ? { ok: true } : { ok: false, code: 'PROVIDER_ERROR' }
  },

  async prepare(input) {
    const res = parseResource(input.resource)
    if (!res) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const fetched = await ghFetch('GET', `${secretsBase(res)}/public-key`, input.credential, input.signal)
    if (!fetched.ok) return { ok: false, code: fetched.code, ...(fetched.maybeApplied ? { maybeApplied: true } : {}) }
    if (!fetched.res.ok) {
      const f = mapStatus(fetched.res)
      return { ok: false, code: f.code, ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}) }
    }
    try {
      const body: unknown = await fetched.res.json()
      if (!isRecord(body) || typeof body['key_id'] !== 'string' || typeof body['key'] !== 'string') return { ok: false, code: 'PROVIDER_ERROR' }
      const session: GithubSession = { keyId: body['key_id'], key: body['key'] }
      return { ok: true, session }
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' }
    }
  },

  async listNames(input) {
    const res = parseResource(input.resource)
    if (!res) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const names: string[] = []
    for (let page = 1; page <= GITHUB_LIST_MAX_PAGES; page += 1) {
      const fetched = await ghFetch('GET', `${secretsBase(res)}?per_page=${GITHUB_LIST_PER_PAGE}&page=${page}`, input.credential, input.signal)
      if (!fetched.ok) return { ok: false, code: fetched.code }
      if (!fetched.res.ok) {
        const f = mapStatus(fetched.res)
        return { ok: false, code: f.code, ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}) }
      }
      let body: unknown
      try {
        body = await fetched.res.json()
      } catch {
        return { ok: false, code: 'PROVIDER_ERROR' }
      }
      if (!isRecord(body) || !Array.isArray(body['secrets'])) return { ok: false, code: 'PROVIDER_ERROR' }
      for (const item of body['secrets']) if (isRecord(item) && typeof item['name'] === 'string') names.push(item['name'])
      const total = typeof body['total_count'] === 'number' ? body['total_count'] : names.length
      if (names.length >= total) return { ok: true, names }
      if (page === GITHUB_LIST_MAX_PAGES) return { ok: false, code: 'PROVIDER_ERROR' } // more than we will read: fail closed
    }
    return { ok: false, code: 'PROVIDER_ERROR' }
  },

  async push(input: PushInput): Promise<PushResult> {
    const res = parseResource(input.resource)
    if (!res) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const session = input.session as GithubSession | undefined
    if (input.ops.some((o) => o.type === 'set') && (!session || typeof session.key !== 'string' || typeof session.keyId !== 'string')) {
      // A set needs the public key from prepare(); its absence is an internal error, not a provider fault.
      return { ok: false, code: 'PROVIDER_ERROR' }
    }
    const results: ItemResult[] = []
    let stop: Failure | null = null
    for (const op of input.ops) {
      if (stop) {
        results.push({ name: op.name, ok: false, code: stop.code })
        continue
      }
      let failure: Failure | null = null
      if (op.type === 'set') {
        let encryptedValue: string
        try {
          encryptedValue = await sealForGitHub(session!.key, op.value)
        } catch {
          // A bad public key (or seal failure) is a validation-class error; never surface the value.
          results.push({ name: op.name, ok: false, code: 'PROVIDER_VALIDATION' })
          continue
        }
        const put = await ghFetch('PUT', `${secretsBase(res)}/${enc(op.name)}`, input.credential, input.signal, { encrypted_value: encryptedValue, key_id: session!.keyId })
        failure = !put.ok ? { code: put.code, ...(put.maybeApplied ? { maybeApplied: true } : {}) } : put.res.ok ? null : mapStatus(put.res)
      } else {
        const del = await ghFetch('DELETE', `${secretsBase(res)}/${enc(op.name)}`, input.credential, input.signal)
        failure = !del.ok ? { code: del.code, ...(del.maybeApplied ? { maybeApplied: true } : {}) } : del.res.ok || del.res.status === 404 ? null : mapStatus(del.res)
      }
      results.push(failure ? { name: op.name, ok: false, ...failure } : { name: op.name, ok: true })
      if (failure && failure.code !== 'PROVIDER_VALIDATION' && failure.code !== 'PROVIDER_ERROR') stop = failure
    }
    return { ok: true, results }
  },
}
