// Cloudflare Workers secrets provider (issue #41). Pushes HushVault secrets to a Worker as Worker secrets
// (type secret_text), one way. Calls ONE fixed host; user input only ever becomes URL-encoded identifier path
// segments that passed a strict regex. Never logs or returns the credential, secret values or provider bodies.
//
// UNVERIFIED against the live API (see docs/integrations/cloudflare-workers.md): the bulk endpoint's HTTP verb,
// the list response envelope, the verify endpoints and per-endpoint status codes. Each is handled defensively.
// The bulk request is PATCH only. There is deliberately NO fallback to PUT: if PUT replaces the whole secret set,
// a fallback could delete every secret that is not in the request.
import type { VerifyResult } from '../provider'
import type { FailureInfo, ItemResult, ProviderErrorCode, PushInput, PushResult, SyncOp, SyncProvider } from '../sync-types'

// The denylist lives in its own module so the engine can enforce it too; re-exported for existing importers.
export { DEFAULT_DENIED_SCRIPTS, deniedScripts, isDeniedScript } from '../target-denylist'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
export const CLOUDFLARE_WORKERS_PROVIDER_ID = 'cloudflare-workers'

/** Documented max operations (create + update + delete) per bulk request. */
export const BULK_MAX_OPERATIONS = 100

// Cloudflare account ids are 32 hex characters.
const ACCOUNT_ID = /^[a-f0-9]{32}$/i
// Worker names: letters, digits, dash, underscore; 63 chars max. No dots, slashes or percent signs.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const enc = encodeURIComponent

/** Cloudflare v4 error codes (from the response body) that sharpen the status mapping. Messages are dropped. */
async function errorCodes(res: Response): Promise<number[]> {
  try {
    const body: unknown = await res.json()
    if (!isRecord(body) || !Array.isArray(body['errors'])) return []
    return body['errors'].flatMap((e: unknown) => (isRecord(e) && typeof e['code'] === 'number' ? [e['code']] : []))
  } catch {
    return []
  }
}

const VALIDATION_CODES = new Set([10016, 10021, 10026, 10054, 10055])

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

async function mapFailure(res: Response): Promise<Failure> {
  const codes = await errorCodes(res)
  if (codes.includes(10007)) return { code: 'TARGET_NOT_FOUND' }
  if (codes.some((c) => VALIDATION_CODES.has(c))) return { code: 'PROVIDER_VALIDATION' }
  if (codes.includes(10035)) return { code: 'PROVIDER_ERROR' }
  switch (res.status) {
    case 401:
    case 403: return { code: 'PROVIDER_AUTH' }
    case 404: return { code: 'TARGET_NOT_FOUND' }
    case 429: {
      const retryAfterSeconds = parseRetryAfter(res)
      return retryAfterSeconds !== undefined ? { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds } : { code: 'PROVIDER_RATE_LIMIT' }
    }
    case 400:
    case 413:
    case 422: return { code: 'PROVIDER_VALIDATION' }
    // A 5xx may be returned after the change was applied: the caller cannot assume it was not.
    case 500:
    case 502:
    case 503:
    case 504: return { code: 'PROVIDER_ERROR', maybeApplied: true }
    default: return { code: 'PROVIDER_ERROR' }
  }
}

type Fetched = { ok: true; res: Response } | ({ ok: false } & Failure)

async function cfFetch(method: string, path: string, credential: string, signal: AbortSignal, body?: unknown): Promise<Fetched> {
  try {
    const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal,
    })
    return { ok: true, res }
  } catch {
    // The request may have reached Cloudflare and been applied before the connection or the timer failed.
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', maybeApplied: true }
  }
}

function parseResource(resource: unknown): Record<string, string> | null {
  if (!isRecord(resource)) return null
  const keys = Object.keys(resource)
  if (keys.length !== 2 || !keys.includes('accountId') || !keys.includes('scriptName')) return null
  const accountId = resource['accountId']
  const scriptName = resource['scriptName']
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return null
  if (typeof scriptName !== 'string' || !SCRIPT_NAME.test(scriptName)) return null
  return { accountId: accountId.toLowerCase(), scriptName }
}

function secretsPath(resource: Record<string, string>): string | null {
  const parsed = parseResource(resource)
  if (!parsed) return null
  return `/accounts/${enc(parsed['accountId'] ?? '')}/workers/scripts/${enc(parsed['scriptName'] ?? '')}/secrets`
}

async function verifyOne(path: string, credential: string, signal: AbortSignal): Promise<'ok' | 'auth' | 'rate' | 'error'> {
  const fetched = await cfFetch('GET', path, credential, signal)
  if (!fetched.ok) return 'error'
  const { res } = fetched
  if (res.status === 429) return 'rate'
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'auth'
  if (!res.ok) return 'error'
  try {
    const body: unknown = await res.json()
    if (!isRecord(body) || body['success'] === false) return 'auth'
    const result = body['result']
    if (isRecord(result) && typeof result['status'] === 'string' && result['status'] !== 'active') return 'auth'
    return 'ok'
  } catch {
    return 'error'
  }
}

/** One bulk request. Returns null on success, else a fixed code (plus what is known about the outcome). */
async function pushChunk(path: string, credential: string, ops: SyncOp[], signal: AbortSignal): Promise<Failure | null> {
  // Object.fromEntries defines own properties, so a name such as "__proto__" can never be swallowed by the
  // prototype setter and silently dropped from the body (the planner also rejects such names).
  const secrets = Object.fromEntries(
    ops.map((op) => [op.name, op.type === 'set' ? { type: 'secret_text', name: op.name, text: op.value } : null] as const),
  )
  const fetched = await cfFetch('PATCH', path, credential, signal, { secrets })
  if (!fetched.ok) return { code: fetched.code, ...(fetched.maybeApplied ? { maybeApplied: true } : {}) }
  if (!fetched.res.ok) return mapFailure(fetched.res)
  try {
    const body: unknown = await fetched.res.json()
    if (isRecord(body) && body['success'] === false) return { code: 'PROVIDER_ERROR' }
  } catch {
    // An empty or non-JSON 2xx body is treated as success.
  }
  return null
}

function readFailure(failure: Failure): { ok: false; code: ProviderErrorCode; retryAfterSeconds?: number } {
  return { ok: false, code: failure.code, ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) }
}

/** True when the list envelope says there is more than this page (result_info totals / cursors / next links). */
function mayBeTruncated(body: Record<string, unknown>, received: number): boolean {
  const info = body['result_info']
  if (!isRecord(info)) return false
  const num = (k: string): number | null => (typeof info[k] === 'number' ? info[k] : null)
  const totalPages = num('total_pages')
  if (totalPages !== null && totalPages > 1) return true
  const total = num('total_count')
  if (total !== null && total > received) return true
  const page = num('page')
  const perPage = num('per_page')
  if (page !== null && perPage !== null && totalPages === null && total === null && received >= perPage) return true
  for (const key of ['cursor', 'cursors', 'next', 'next_cursor', 'next_page']) {
    const v = info[key]
    if (typeof v === 'string' && v !== '') return true
    if (isRecord(v) && Object.values(v).some((x) => typeof x === 'string' && x !== '')) return true
  }
  return false
}

export const cloudflareWorkersProvider: SyncProvider = {
  id: CLOUDFLARE_WORKERS_PROVIDER_ID,
  // Conservative: 64 is the Free plan's variable cap (secrets + text vars); the paid cap is 128. The engine
  // also uses this as the batch size, which keeps every request under the documented 100 operations.
  limits: { maxItems: 64, maxNameLength: 64, maxValueBytes: 5 * 1024 },

  parseConfig(config) {
    if (!isRecord(config)) return null
    const keys = Object.keys(config)
    if (keys.length !== 1 || keys[0] !== 'accountId') return null
    const accountId = config['accountId']
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return null
    return { accountId: accountId.toLowerCase() }
  },

  parseResource,

  async verify(credential, config, signal): Promise<VerifyResult> {
    const raw = config['accountId']
    const accountId = typeof raw === 'string' && ACCOUNT_ID.test(raw) ? raw : null
    if (!accountId) return { ok: false, code: 'PROVIDER_ERROR' }
    // Account-owned tokens verify at the account; user tokens at /user/tokens/verify. Which endpoint accepts which
    // token type is unverified, so try the account endpoint first and fall back to the user endpoint on rejection.
    const first = await verifyOne(`/accounts/${enc(accountId)}/tokens/verify`, credential, signal)
    if (first === 'ok') return { ok: true }
    if (first === 'rate') return { ok: false, code: 'PROVIDER_RATE_LIMIT' }
    const second = await verifyOne('/user/tokens/verify', credential, signal)
    if (second === 'ok') return { ok: true }
    if (second === 'rate') return { ok: false, code: 'PROVIDER_RATE_LIMIT' }
    return { ok: false, code: first === 'auth' && second === 'auth' ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR' }
  },

  async listNames(input) {
    const path = secretsPath(input.resource)
    if (!path) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const fetched = await cfFetch('GET', path, input.credential, input.signal)
    // A read changes nothing, so "maybe applied" is meaningless here: only the code (and Retry-After) is reported.
    if (!fetched.ok) return { ok: false, code: fetched.code }
    if (!fetched.res.ok) return readFailure(await mapFailure(fetched.res))
    try {
      const body: unknown = await fetched.res.json()
      if (!isRecord(body) || body['success'] === false || !Array.isArray(body['result'])) return { ok: false, code: 'PROVIDER_ERROR' }
      // Pagination is not implemented (the docs do not confirm the cursor contract), so any sign of a partial page
      // fails closed: planning against a truncated list would misclassify names as missing or as ours.
      if (mayBeTruncated(body, (body['result'] as unknown[]).length)) return { ok: false, code: 'PROVIDER_ERROR' }
      const names: string[] = []
      for (const item of body['result'] as unknown[]) {
        if (isRecord(item) && typeof item['name'] === 'string') names.push(item['name'])
      }
      return { ok: true, names }
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' }
    }
  },

  async push(input: PushInput): Promise<PushResult> {
    const path = secretsPath(input.resource)
    if (!path) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const results: ItemResult[] = []
    let stop: Failure | null = null
    for (let offset = 0; offset < input.ops.length; offset += BULK_MAX_OPERATIONS) {
      const chunk = input.ops.slice(offset, offset + BULK_MAX_OPERATIONS)
      if (stop) {
        // Never sent: a definite failure, whatever the stopping chunk's outcome was.
        for (const op of chunk) results.push({ name: op.name, ok: false, code: stop.code })
        continue
      }
      const failure = await pushChunk(path, input.credential, chunk, input.signal)
      for (const op of chunk) results.push(failure ? { name: op.name, ok: false, ...failure } : { name: op.name, ok: true })
      if (failure && failure.code !== 'PROVIDER_VALIDATION' && failure.code !== 'PROVIDER_ERROR') stop = failure
    }
    return { ok: true, results }
  },
}
