// Fixtures for the sync engine tests: a scripted fake SyncProvider and seeding helpers.
import { encryptCredentialWithRing, loadKeyRing } from '../../src/crypto/envelope'
import { registerProvider } from '../../src/integrations/provider'
import { newFingerprintSalt } from '../../src/integrations/sync-engine'
import type { ProviderErrorCode, ProviderLimits, PushInput, PushResult, SyncOp, SyncProvider } from '../../src/integrations/sync-types'
import { createPrefixedId } from '../../src/lib/auth'
import { seedEnvironment, seedProject, seedUser, type TestEnv } from './env'
import { seedComputed, seedSecret } from './env-secrets'

export const FAKE_PROVIDER_ID = 'fake-sync'
export const CREDENTIAL = 'cf-token-CRED-CANARY-5d1e9a'

export type FakeProvider = SyncProvider & {
  /** Names (and values) currently "on the target". */
  remote: Map<string, string>
  listCalls: number
  pushCalls: SyncOp[][]
  credentialsSeen: string[]
  /** Return a PushResult to override the normal behaviour for one push call. */
  script: Array<(input: PushInput) => PushResult | Promise<PushResult> | undefined>
  /** If set, the next listNames fails with this code. */
  listError: ProviderErrorCode | null
  /** If set, every push awaits it first (concurrency tests). */
  gate: Promise<void> | null
  limits: ProviderLimits
}

export function makeFakeProvider(limits: Partial<ProviderLimits> = {}): FakeProvider {
  const provider: FakeProvider = {
    id: FAKE_PROVIDER_ID,
    limits: { maxItems: 100, maxNameLength: 64, maxValueBytes: 1024, ...limits },
    remote: new Map(),
    listCalls: 0,
    pushCalls: [],
    credentialsSeen: [],
    script: [],
    listError: null,
    gate: null,
    async verify() { return { ok: true } },
    parseConfig(config) { return (config ?? {}) as Record<string, unknown> },
    parseResource(resource) { return resource && typeof resource === 'object' ? (resource as Record<string, string>) : null },
    async listNames(input) {
      provider.listCalls += 1
      provider.credentialsSeen.push(input.credential)
      if (provider.listError) return { ok: false, code: provider.listError }
      return { ok: true, names: [...provider.remote.keys()] }
    },
    async push(input) {
      provider.pushCalls.push(input.ops.map((o) => ({ ...o })))
      provider.credentialsSeen.push(input.credential)
      if (provider.gate) await provider.gate
      const scripted = provider.script.shift()?.(input)
      if (scripted !== undefined) {
        const result = await scripted
        if (result.ok) {
          // Apply only the items the script reports ok, like a real partial failure.
          for (const r of result.results) {
            const op = input.ops.find((o) => o.name === r.name)
            if (!r.ok || !op) continue
            if (op.type === 'set') provider.remote.set(op.name, op.value)
            else provider.remote.delete(op.name)
          }
        }
        return result
      }
      for (const op of input.ops) {
        if (op.type === 'set') provider.remote.set(op.name, op.value)
        else provider.remote.delete(op.name)
      }
      return { ok: true, results: input.ops.map((o) => ({ name: o.name, ok: true as const })) }
    },
  }
  return provider
}

export function installFakeProvider(limits?: Partial<ProviderLimits>): FakeProvider {
  const provider = makeFakeProvider(limits)
  registerProvider(provider)
  return provider
}

export async function seedConnection(env: TestEnv, orgId: string, userId: string | null, credential = CREDENTIAL) {
  const id = createPrefixedId('icn')
  const sealed = await encryptCredentialWithRing(credential, loadKeyRing(env), { orgId, connectionId: id })
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO integration_connections (id, org_id, provider, label, config_json, encrypted_credential, wrapped_dek, key_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, orgId, FAKE_PROVIDER_ID, `conn-${id.slice(-6)}`, '{"accountId":"acc1"}', sealed.encryptedCredential, sealed.wrappedDek, sealed.keyVersion, userId, now, now).run()
  return id
}

export async function seedTarget(
  env: TestEnv,
  t: { orgId: string; projectId: string; envId: string; connectionId: string; userId?: string | null; deleteRemoved?: boolean; nameFilter?: Record<string, unknown>; resource?: Record<string, string> },
) {
  const id = createPrefixedId('ist')
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO sync_targets (id, org_id, project_id, env_id, connection_id, provider, resource_json, name_filter_json, delete_removed, fingerprint_salt, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, t.orgId, t.projectId, t.envId, t.connectionId, FAKE_PROVIDER_ID, JSON.stringify(t.resource ?? { scriptName: 'worker-a' }), JSON.stringify(t.nameFilter ?? {}), t.deleteRemoved ? 1 : 0, newFingerprintSalt(), 'active', t.userId ?? null, now, now).run()
  return id
}

/** One org with a project, an environment, a connection and a target. */
export async function setupSyncWorld(env: TestEnv, opts: { deleteRemoved?: boolean; nameFilter?: Record<string, unknown>; secrets?: Record<string, string> } = {}) {
  const user = await seedUser(env, { role: 'admin' })
  const projectId = await seedProject(env, user.orgId)
  const envId = await seedEnvironment(env, projectId)
  for (const [name, value] of Object.entries(opts.secrets ?? { DB_URL: 'postgres://x', API_KEY: 'k-1' })) {
    await seedSecret(env, projectId, envId, name, value)
  }
  const connectionId = await seedConnection(env, user.orgId, user.userId)
  const targetId = await seedTarget(env, { orgId: user.orgId, projectId, envId, connectionId, userId: user.userId, deleteRemoved: opts.deleteRemoved, nameFilter: opts.nameFilter })
  return { ...user, projectId, envId, connectionId, targetId }
}

export { seedComputed, seedSecret }
