// Cloudflare Workers secrets provider (issue #41). Pushes HushVault secrets to a Worker as Worker secrets
// (type secret_text), one way. Calls ONE fixed host; user input only ever becomes URL-encoded identifier path
// segments that passed a strict regex. Never logs or returns the credential, secret values or provider bodies.
//
// UNVERIFIED against the live API (see docs/integrations/cloudflare-workers.md): the bulk endpoint's HTTP verb,
// the list response envelope, the verify endpoints and per-endpoint status codes. Each is handled defensively.
import type { Env } from '../../index'
import type { VerifyResult } from '../provider'
import type { ItemResult, ProviderErrorCode, PushInput, PushResult, SyncOp, SyncProvider } from '../sync-types'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
export const CLOUDFLARE_WORKERS_PROVIDER_ID = 'cloudflare-workers'

/** Documented max operations (create + update + delete) per bulk request. */
export const BULK_MAX_OPERATIONS = 100

// Cloudflare account ids are 32 hex characters.
const ACCOUNT_ID = /^[a-f0-9]{32}$/i
// Worker names: letters, digits, dash, underscore; 63 chars max. No dots, slashes or percent signs.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/

/** Scripts that may never be a sync target, whatever the env var says (HushVault's own Workers). */
export const DEFAULT_DENIED_SCRIPTS: readonly string[] = ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev']

/** Default list plus the comma separated HUSHVAULT_SYNC_DENY_SCRIPTS var, lower-cased. The var can only add. */
export function deniedScripts(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS'> | undefined): Set<string> {
  const extra = (env?.HUSHVAULT_SYNC_DENY_SCRIPTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...DEFAULT_DENIED_SCRIPTS, ...extra])
}

export function isDeniedScript(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS'> | undefined, scriptName: string): boolean {
  return deniedScripts(env).has(scriptName.toLowerCase())
}

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

async function mapFailure(res: Response): Promise<ProviderErrorCode> {
  const codes = await errorCodes(res)
  if (codes.includes(10007)) return 'TARGET_NOT_FOUND'
  if (codes.some((c) => VALIDATION_CODES.has(c))) return 'PROVIDER_VALIDATION'
  if (codes.includes(10035)) return 'PROVIDER_ERROR'
  switch (res.status) {
    case 401:
    case 403: return 'PROVIDER_AUTH'
    case 404: return 'TARGET_NOT_FOUND'
    case 429: return 'PROVIDER_RATE_LIMIT'
    case 400:
    case 413:
    case 422: return 'PROVIDER_VALIDATION'
    default: return 'PROVIDER_ERROR'
  }
}

type Fetched = { ok: true; res: Response } | { ok: false; code: ProviderErrorCode }

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
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR' }
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

/** One bulk request. Returns null on success, else a fixed code. */
async function pushChunk(path: string, credential: string, ops: SyncOp[], signal: AbortSignal): Promise<ProviderErrorCode | null> {
  const secrets: Record<string, unknown> = {}
  for (const op of ops) {
    secrets[op.name] = op.type === 'set' ? { type: 'secret_text', name: op.name, text: op.value } : null
  }
  // The bulk verb is unconfirmed (PATCH expected: "omitted secrets are unchanged"). Fall back to PUT on 405 only.
  let fetched = await cfFetch('PATCH', path, credential, signal, { secrets })
  if (fetched.ok && fetched.res.status === 405) fetched = await cfFetch('PUT', path, credential, signal, { secrets })
  if (!fetched.ok) return fetched.code
  if (!fetched.res.ok) return mapFailure(fetched.res)
  try {
    const body: unknown = await fetched.res.json()
    if (isRecord(body) && body['success'] === false) return 'PROVIDER_ERROR'
  } catch {
    // An empty or non-JSON 2xx body is treated as success.
  }
  return null
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
    if (!fetched.ok) return fetched
    if (!fetched.res.ok) return { ok: false, code: await mapFailure(fetched.res) }
    try {
      const body: unknown = await fetched.res.json()
      if (!isRecord(body) || body['success'] === false || !Array.isArray(body['result'])) return { ok: false, code: 'PROVIDER_ERROR' }
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
    let stopCode: ProviderErrorCode | null = null
    for (let offset = 0; offset < input.ops.length; offset += BULK_MAX_OPERATIONS) {
      const chunk = input.ops.slice(offset, offset + BULK_MAX_OPERATIONS)
      if (stopCode) {
        for (const op of chunk) results.push({ name: op.name, ok: false, code: stopCode })
        continue
      }
      const code = await pushChunk(path, input.credential, chunk, input.signal)
      for (const op of chunk) results.push(code ? { name: op.name, ok: false, code } : { name: op.name, ok: true })
      if (code && code !== 'PROVIDER_VALIDATION' && code !== 'PROVIDER_ERROR') stopCode = code
    }
    return { ok: true, results }
  },
}
