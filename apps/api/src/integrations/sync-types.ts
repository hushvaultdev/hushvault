// Contract between the sync engine (M2) and providers (M3+). Providers push values and report per-item
// results; they never persist anything, never log values or credentials, and call fixed API hosts only.
import type { IntegrationProvider } from './provider'

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
}

export interface PushInput {
  credential: string
  /** Non-secret connection config (identifiers only). */
  config: Record<string, unknown>
  /** Target resource identifiers, already validated by parseResource. */
  resource: Record<string, string>
  ops: SyncOp[]
  signal: AbortSignal
}

export interface SyncProvider extends IntegrationProvider {
  readonly limits: ProviderLimits
  /** Returns the sanitized resource identifiers, or null when invalid. Identifiers only, never URLs. */
  parseResource(resource: unknown): Record<string, string> | null
  /** Names currently on the target (never values), for conflict detection. Null when the provider cannot list. */
  listNames(input: Omit<PushInput, 'ops'>): Promise<{ ok: true; names: string[] } | ({ ok: false; code: ProviderErrorCode } & FailureInfo)>
  /** Apply a batch (the engine already chunks to `limits.maxItems`). Idempotent: deleting a missing name is ok. */
  push(input: PushInput): Promise<PushResult>
}

export function isSyncProvider(provider: IntegrationProvider | undefined): provider is SyncProvider {
  return Boolean(provider && 'push' in provider && 'parseResource' in provider && 'listNames' in provider)
}
