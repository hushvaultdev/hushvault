// Shared plumbing for the providers that talk to the Cloudflare v4 API (Workers, Pages). Calls ONE fixed host;
// callers pass only strictly validated, URL-encoded identifier path segments. Never logs or returns the credential,
// secret values or provider response bodies: failures collapse to fixed codes.
import type { VerifyResult } from '../provider'
import type { FailureInfo, ProviderErrorCode } from '../sync-types'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

// Cloudflare account ids are 32 hex characters.
export const ACCOUNT_ID = /^[a-f0-9]{32}$/i

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const enc = encodeURIComponent

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

export type Failure = { code: ProviderErrorCode } & FailureInfo

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

/** `notFoundCodes` are the product-specific "resource does not exist" error codes (Workers script: 10007). */
export async function mapFailure(res: Response, notFoundCodes: readonly number[] = [10007]): Promise<Failure> {
  const codes = await errorCodes(res)
  if (codes.some((c) => notFoundCodes.includes(c))) return { code: 'TARGET_NOT_FOUND' }
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

export type Fetched = { ok: true; res: Response } | ({ ok: false } & Failure)

export async function cfFetch(method: string, path: string, credential: string, signal: AbortSignal, body?: unknown): Promise<Fetched> {
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

/** Read-only credential check. Which endpoint accepts which token type is unverified, so try the account one first. */
export async function verifyCloudflareToken(credential: string, config: Record<string, unknown>, signal: AbortSignal): Promise<VerifyResult> {
  const raw = config['accountId']
  const accountId = typeof raw === 'string' && ACCOUNT_ID.test(raw) ? raw : null
  if (!accountId) return { ok: false, code: 'PROVIDER_ERROR' }
  const first = await verifyOne(`/accounts/${enc(accountId)}/tokens/verify`, credential, signal)
  if (first === 'ok') return { ok: true }
  if (first === 'rate') return { ok: false, code: 'PROVIDER_RATE_LIMIT' }
  const second = await verifyOne('/user/tokens/verify', credential, signal)
  if (second === 'ok') return { ok: true }
  if (second === 'rate') return { ok: false, code: 'PROVIDER_RATE_LIMIT' }
  return { ok: false, code: first === 'auth' && second === 'auth' ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR' }
}

export function readFailure(failure: Failure): { ok: false; code: ProviderErrorCode; retryAfterSeconds?: number } {
  return { ok: false, code: failure.code, ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) }
}

/** True when the list envelope says there is more than this page (result_info totals / cursors / next links). */
export function mayBeTruncated(body: Record<string, unknown>, received: number): boolean {
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
