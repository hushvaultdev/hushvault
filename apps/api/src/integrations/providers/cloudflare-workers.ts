// Cloudflare Workers secrets provider (issue #41). Pushes HushVault secrets to a Worker as Worker secrets
// (type secret_text), one way. Calls ONE fixed host; user input only ever becomes URL-encoded identifier path
// segments that passed a strict regex. Never logs or returns the credential, secret values or provider bodies.
//
// VERIFIED live against a real Worker (2026-10-12, issue #41): the bulk mutate endpoint is
// `PATCH /accounts/{id}/workers/scripts/{script}/secrets-bulk` (RFC 7396 merge patch, null deletes,
// omitted names untouched, <=100 ops). The list endpoint is `GET .../secrets`. These are DISTINCT
// paths — PATCH on `.../secrets` returns 10405 and writes nothing, which is the bug this corrected.
// Still handled defensively. The bulk request is PATCH only: there is deliberately NO fallback to a
// per-secret PUT, which replaces the whole set and would delete every secret not in the request.
import type { VerifyResult } from '../provider'
import type { ItemResult, PushInput, PushResult, SyncOp, SyncProvider, SyncResourceSpec } from '../sync-types'
import { ACCOUNT_ID, cfFetch, enc, isRecord, mapFailure, mayBeTruncated, readFailure, verifyCloudflareToken, type Failure } from './cloudflare-api'

// Re-exported for existing importers (the shared module is the source of truth).
export { CLOUDFLARE_API_BASE, parseRetryAfter } from './cloudflare-api'

// The denylist lives in its own module so the engine can enforce it too; re-exported for existing importers.
export { DEFAULT_DENIED_SCRIPTS, deniedScripts, isDeniedScript } from '../target-denylist'

export const CLOUDFLARE_WORKERS_PROVIDER_ID = 'cloudflare-workers'

/** Documented max operations (create + update + delete) per bulk request. */
export const BULK_MAX_OPERATIONS = 100

// Worker names: letters, digits, dash, underscore; 63 chars max. No dots, slashes or percent signs.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/

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

// GET list of a script's secrets (names + types only). Used by verify and listNames.
function secretsPath(resource: SyncResourceSpec): string | null {
  const parsed = parseResource(resource)
  if (!parsed) return null
  return `/accounts/${enc(parsed['accountId'] ?? '')}/workers/scripts/${enc(parsed['scriptName'] ?? '')}/secrets`
}

// Bulk create/update/delete endpoint (RFC 7396 merge patch). This is a DISTINCT endpoint from the
// list path above: it is `.../secrets-bulk`, not `.../secrets`. PATCH on `.../secrets` returns
// 10405 "Method not allowed for this authentication scheme" and nothing is written (verified live
// against a real Worker, 2026-10-12, issue #41). A value of null deletes a name; omitted names are
// left unchanged; up to 100 operations per request.
function secretsBulkPath(resource: SyncResourceSpec): string | null {
  const parsed = parseResource(resource)
  if (!parsed) return null
  return `/accounts/${enc(parsed['accountId'] ?? '')}/workers/scripts/${enc(parsed['scriptName'] ?? '')}/secrets-bulk`
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

  verify(credential, config, signal): Promise<VerifyResult> {
    return verifyCloudflareToken(credential, config, signal)
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
    const path = secretsBulkPath(input.resource)
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
