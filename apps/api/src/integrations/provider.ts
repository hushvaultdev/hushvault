// Outbound integration providers (issue #39). A provider knows how to check a credential with a
// read-only call and how to validate its own non-secret config. It never persists anything and
// never logs or returns the credential. Providers are added per milestone (Cloudflare Workers in M3).
import { INTEGRATIONS, isConnectableStatus } from '@hushvault/shared'

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_ERROR' }

export interface IntegrationProvider {
  /** Registry id from @hushvault/shared (e.g. `cloudflare-workers`). */
  readonly id: string
  /** Read-only check that the credential works. Must not echo the credential or provider error bodies. */
  verify(credential: string, config: Record<string, unknown>, signal: AbortSignal): Promise<VerifyResult>
  /**
   * Returns the sanitized non-secret config, or null when invalid. Accept identifiers only (account id, worker name),
   * never URLs or hosts: providers call fixed API hosts, so user input cannot steer a request (SSRF).
   */
  parseConfig(config: unknown): Record<string, unknown> | null
}

const providers = new Map<string, IntegrationProvider>()

export function registerProvider(provider: IntegrationProvider): void {
  providers.set(provider.id, provider)
}

/**
 * Any registered provider, regardless of registry status. Callers that resolve a provider from
 * a persisted connection row (sync engine, credential rotation, target checks) use this: the
 * gate at `getConnectableProvider` already applied when the connection was created, so
 * demoting a provider to `planned` here would silently break running syncs rather than make
 * them safer.
 */
export function getProvider(id: string): IntegrationProvider | undefined {
  return providers.get(id)
}

/**
 * The public write boundary. The gate closes only on providers EXPLICITLY marked `planned` in
 * the shared registry — a provider with no registry entry at all (test fixtures like
 * `fake-sync`, internal registrations) falls through to the registered provider, preserving the
 * pre-#110-fix behavior for those. `POST /api/integrations/connections` goes through this, so a
 * `planned` provider can be registered (for internal e2e drills, benchmarks) without being
 * publicly reachable. Promoting `planned` → `beta` in `packages/shared/src/integrations.ts` is
 * enough to open the gate, no API code change needed. Fixes the design flaw #110 exposed.
 */
export function getConnectableProvider(id: string): IntegrationProvider | undefined {
  const info = INTEGRATIONS.find((i) => i.id === id)
  if (info && !isConnectableStatus(info.status)) return undefined
  return providers.get(id)
}

/**
 * Ids that `getConnectableProvider` would return. Drives the `connectable` flag on
 * `GET /api/integrations/providers`, so the dashboard shows the same truth the write path
 * enforces. A registered provider with no registry entry is included (same semantics as the
 * gate), though in practice such providers never surface on the dashboard anyway because the
 * `/providers` endpoint walks the registry.
 */
export function connectableProviderIds(): string[] {
  return [...providers.keys()].filter((id) => {
    const info = INTEGRATIONS.find((i) => i.id === id)
    return !info || isConnectableStatus(info.status)
  })
}
