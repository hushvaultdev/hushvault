// Cloudflare Pages environment variables provider (issue #45). Pushes HushVault secrets to a Pages project's
// production or preview environment as `secret_text` variables, one way. Calls ONE fixed host; user input only
// ever becomes URL-encoded identifier path segments that passed a strict regex. Never logs or returns the
// credential, secret values or provider bodies.
//
// NOT VERIFIED against a live Pages project (the registry keeps this integration `planned`). Assumed from the API
// reference and to be proven by scripts/phase6-pages-e2e-drill.mjs before promotion:
//   - `PATCH /accounts/{id}/pages/projects/{name}` merges `deployment_configs.{env}.env_vars` key by key, a null
//     entry deletes that name, and omitted names (and every other deployment setting, e.g. bindings) are untouched.
//     If PATCH instead REPLACES the environment's config, a push could wipe a project's bindings: that is the first
//     thing the drill must check, and why this must not be promoted without it.
//   - `GET` of the same path returns each environment's `env_vars` as { NAME: { type, value } }; only the NAMES are
//     read, and plain-text values are never logged or returned.
// Limits below are conservative guesses until confirmed.
import type { VerifyResult } from '../provider'
import type { ItemResult, PushInput, PushResult, SyncOp, SyncProvider, SyncResourceSpec } from '../sync-types'
import { ACCOUNT_ID, cfFetch, enc, isRecord, mapFailure, readFailure, verifyCloudflareToken, type Failure } from './cloudflare-api'

export const CLOUDFLARE_PAGES_PROVIDER_ID = 'cloudflare-pages'

/** Operations per PATCH. Equals limits.maxItems, which is also the engine's batch size. */
export const PAGES_MAX_OPERATIONS = 64

// Pages project names are lowercase letters, digits and dashes (58 chars max). No dots, slashes or percent signs.
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,57}$/
const ENVIRONMENTS = ['production', 'preview'] as const
type PagesEnvironment = (typeof ENVIRONMENTS)[number]

// Pages' own "project not found" error code (in addition to a plain 404).
const PROJECT_NOT_FOUND_CODES = [8000007]

interface ParsedResource { accountId: string; projectName: string; environment: PagesEnvironment }

function parsePagesResource(resource: unknown): ParsedResource | null {
  if (!isRecord(resource)) return null
  const keys = Object.keys(resource)
  if (keys.length !== 3 || !keys.includes('accountId') || !keys.includes('projectName') || !keys.includes('environment')) return null
  const accountId = resource['accountId']
  const projectName = resource['projectName']
  const environment = resource['environment']
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return null
  if (typeof projectName !== 'string' || !PROJECT_NAME.test(projectName)) return null
  if (environment !== 'production' && environment !== 'preview') return null
  return { accountId: accountId.toLowerCase(), projectName, environment }
}

function parseResource(resource: unknown): Record<string, string> | null {
  const parsed = parsePagesResource(resource)
  return parsed ? { accountId: parsed.accountId, projectName: parsed.projectName, environment: parsed.environment } : null
}

function projectPath(resource: SyncResourceSpec): { path: string; environment: PagesEnvironment } | null {
  const parsed = parsePagesResource(resource)
  if (!parsed) return null
  return { path: `/accounts/${enc(parsed.accountId)}/pages/projects/${enc(parsed.projectName)}`, environment: parsed.environment }
}

/** One PATCH. Returns null on success, else a fixed code (plus what is known about the outcome). */
async function pushChunk(path: string, environment: PagesEnvironment, credential: string, ops: SyncOp[], signal: AbortSignal): Promise<Failure | null> {
  // Object.fromEntries defines own properties, so a name such as "__proto__" can never be swallowed by the
  // prototype setter and silently dropped from the body (the planner also rejects such names).
  const envVars = Object.fromEntries(
    ops.map((op) => [op.name, op.type === 'set' ? { type: 'secret_text', value: op.value } : null] as const),
  )
  const fetched = await cfFetch('PATCH', path, credential, signal, { deployment_configs: { [environment]: { env_vars: envVars } } })
  if (!fetched.ok) return { code: fetched.code, ...(fetched.maybeApplied ? { maybeApplied: true } : {}) }
  if (!fetched.res.ok) return mapFailure(fetched.res, PROJECT_NOT_FOUND_CODES)
  try {
    const body: unknown = await fetched.res.json()
    if (isRecord(body) && body['success'] === false) return { code: 'PROVIDER_ERROR' }
  } catch {
    // An empty or non-JSON 2xx body is treated as success.
  }
  return null
}

export const cloudflarePagesProvider: SyncProvider = {
  id: CLOUDFLARE_PAGES_PROVIDER_ID,
  limits: { maxItems: PAGES_MAX_OPERATIONS, maxNameLength: 64, maxValueBytes: 5 * 1024 },

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
    const target = projectPath(input.resource)
    if (!target) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const fetched = await cfFetch('GET', target.path, input.credential, input.signal)
    // A read changes nothing, so "maybe applied" is meaningless here: only the code (and Retry-After) is reported.
    if (!fetched.ok) return { ok: false, code: fetched.code }
    if (!fetched.res.ok) return readFailure(await mapFailure(fetched.res, PROJECT_NOT_FOUND_CODES))
    try {
      const body: unknown = await fetched.res.json()
      if (!isRecord(body) || body['success'] === false || !isRecord(body['result'])) return { ok: false, code: 'PROVIDER_ERROR' }
      const configs = body['result']['deployment_configs']
      const env = isRecord(configs) ? configs[target.environment] : undefined
      // An environment block we cannot read fails closed: planning against a list we do not understand would
      // misclassify names as missing (and so as safe to create over) or as ours.
      if (!isRecord(env)) return { ok: false, code: 'PROVIDER_ERROR' }
      const vars = env['env_vars']
      if (vars === null || vars === undefined) return { ok: true, names: [] }
      if (!isRecord(vars)) return { ok: false, code: 'PROVIDER_ERROR' }
      return { ok: true, names: Object.keys(vars) }
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' }
    }
  },

  async push(input: PushInput): Promise<PushResult> {
    const target = projectPath(input.resource)
    if (!target) return { ok: false, code: 'PROVIDER_VALIDATION' }
    const results: ItemResult[] = []
    let stop: Failure | null = null
    for (let offset = 0; offset < input.ops.length; offset += PAGES_MAX_OPERATIONS) {
      const chunk = input.ops.slice(offset, offset + PAGES_MAX_OPERATIONS)
      if (stop) {
        // Never sent: a definite failure, whatever the stopping chunk's outcome was.
        for (const op of chunk) results.push({ name: op.name, ok: false, code: stop.code })
        continue
      }
      const failure = await pushChunk(target.path, target.environment, input.credential, chunk, input.signal)
      for (const op of chunk) results.push(failure ? { name: op.name, ok: false, ...failure } : { name: op.name, ok: true })
      if (failure && failure.code !== 'PROVIDER_VALIDATION' && failure.code !== 'PROVIDER_ERROR') stop = failure
    }
    return { ok: true, results }
  },
}
