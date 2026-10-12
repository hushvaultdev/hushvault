// Contract between the sync engine (M2) and providers (M3+). Providers push values and report per-item
// results; they never persist anything, never log values or credentials, and call fixed API hosts only.
import type { SyncResourceSpec } from '@hushvault/shared/integrations'
import type { IntegrationProvider } from './provider'

export type { SyncResourceSpec, SyncResourceValue } from '@hushvault/shared/integrations'

export type SyncOp = { type: 'set'; name: string; value: string } | { type: 'delete'; name: string }

export type ProviderErrorCode = 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_VALIDATION' | 'PROVIDER_ERROR' | 'TARGET_NOT_FOUND' | 'TIMEOUT'

/**
 * Extra facts a failure may carry. `maybeApplied`: the provider cannot tell whether the change landed (network
 * error, lost response, 5xx); the engine then keeps the intent ledger row instead of discarding it.
 * `retryAfterSeconds`: the provider's own Retry-After, which the retry scheduler must respect.
 */
export type FailureInfo = { maybeApplied?: boolean; retryAfterSeconds?: number }

export type ItemResult = { name: string; ok: true } | ({ name: string; ok: false; code: ProviderErrorCode } & FailureInfo)

export type PushResult =
  | { ok: true; results: ItemResult[] }
  | ({ ok: false; code: ProviderErrorCode } & FailureInfo)

export interface ProviderLimits {
  maxItems: number
  maxNameLength: number
  maxValueBytes: number
  /**
   * Ops the engine sends to `push()` in one call. Defaults to `maxItems`. A provider with a bulk endpoint
   * (Cloudflare) leaves this unset and takes the whole batch; a provider WITHOUT a bulk endpoint (GitHub,
   * GitLab) sets it small, because each op becomes one sequential HTTP request and the chunk must finish
   * inside `pushTimeoutMs`.
   */
  maxOpsPerChunk?: number
  /** Hard timeout for one `listNames()` call. Defaults to the engine's LIST_TIMEOUT_MS. */
  listTimeoutMs?: number
  /** Hard timeout for one `push()` call (one chunk). Defaults to the engine's PUSH_TIMEOUT_MS. A no-bulk
   * provider doing N sequential requests per chunk needs this larger than the bulk default. */
  pushTimeoutMs?: number
}

/**
 * Opaque per-run state a provider computes once in `prepare()` and reads back in `push()`. The engine never
 * inspects it; a provider casts it to its own type. GitHub, for example, fetches the repo/environment public key
 * here so it is fetched once per run rather than once per chunk. Providers with no per-run state omit `prepare`.
 */
export type ProviderSession = unknown

export type PrepareResult =
  | { ok: true; session: ProviderSession }
  | ({ ok: false; code: ProviderErrorCode } & FailureInfo)

export interface PushInput {
  credential: string
  /** Non-secret connection config (identifiers only). */
  config: Record<string, unknown>
  /** Target resource identifiers/flags, already validated by parseResource. */
  resource: SyncResourceSpec
  ops: SyncOp[]
  /** The value returned by `prepare()` for this run, or undefined when the provider has no `prepare`. */
  session?: ProviderSession
  signal: AbortSignal
}

/** A per-name value blocker, from the fixed SyncPlanDto blocker vocabulary. */
export type ValueBlocker = 'EMPTY_VALUE' | 'VALUE_TOO_LARGE'

export interface SyncProvider extends IntegrationProvider {
  readonly limits: ProviderLimits
  /**
   * True when `name` is an acceptable variable name for this provider. When absent the engine applies its default
   * (`/^[A-Za-z_][A-Za-z0-9_]*$/` and `name.length <= maxNameLength`). Provider-specific reasons (GitHub has no
   * `GITHUB_` prefix; a GitLab masked key must be long enough) still surface as the single `NAME_INVALID` blocker.
   * The engine ALWAYS additionally rejects prototype-polluting names (`__proto__`, `constructor`, `prototype`)
   * regardless of this hook, because they can corrupt a request body — a provider cannot opt back into them.
   */
  validateName?(name: string): boolean
  /**
   * For a name this provider would reject, suggest a valid name the user could rename their secret to (e.g.
   * `db-url` -> `DB_URL`), or null when it cannot (already valid, or nothing sensible to suggest). This is a HINT
   * surfaced on the NAME_INVALID blocker only; the engine never applies it — HushVault does not silently rename.
   */
  suggestName?(name: string): string | null
  /**
   * A blocker code when `value` is unacceptable for `name`, else null. When absent the engine applies its default
   * (empty -> EMPTY_VALUE; UTF-8 byte length > maxValueBytes -> VALUE_TOO_LARGE). A GitLab masked value that is too
   * short, for instance, maps onto VALUE_TOO_LARGE's sibling at the provider's discretion.
   */
  validateValue?(name: string, value: string): ValueBlocker | null
  /** Returns the sanitized resource identifiers/flags, or null when invalid. Identifiers only, never URLs. */
  parseResource(resource: unknown): SyncResourceSpec | null
  /** Names currently on the target (never values), for conflict detection. Null when the provider cannot list. */
  listNames(input: Omit<PushInput, 'ops' | 'session'>): Promise<{ ok: true; names: string[] } | ({ ok: false; code: ProviderErrorCode } & FailureInfo)>
  /**
   * Optional once-per-run setup, called after listNames and before the first push. Its session is threaded into
   * every push() call of the run. A failure aborts the run with the returned code (no push happens). Providers
   * with no per-run state omit this and push() receives `session: undefined`.
   */
  prepare?(input: Omit<PushInput, 'ops' | 'session'>): Promise<PrepareResult>
  /** Apply a batch (the engine already chunks to `limits.maxItems`). Idempotent: deleting a missing name is ok. */
  push(input: PushInput): Promise<PushResult>
}

export function isSyncProvider(provider: IntegrationProvider | undefined): provider is SyncProvider {
  return Boolean(provider && 'push' in provider && 'parseResource' in provider && 'listNames' in provider)
}
