// Outbound integration providers (issue #39). A provider knows how to check a credential with a
// read-only call and how to validate its own non-secret config. It never persists anything and
// never logs or returns the credential. Providers are added per milestone (Cloudflare Workers in M3).
export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_ERROR' }

export interface IntegrationProvider {
  /** Registry id from @hushvault/shared (e.g. `cloudflare-workers`). */
  readonly id: string
  /** Read-only check that the credential works. Must not echo the credential or provider error bodies. */
  verify(credential: string, config: Record<string, unknown>): Promise<VerifyResult>
  /** Returns the sanitized non-secret config, or null when invalid. */
  parseConfig(config: unknown): Record<string, unknown> | null
}

const providers = new Map<string, IntegrationProvider>()

export function registerProvider(provider: IntegrationProvider): void {
  providers.set(provider.id, provider)
}

export function getProvider(id: string): IntegrationProvider | undefined {
  return providers.get(id)
}

export function connectableProviderIds(): string[] {
  return [...providers.keys()]
}
