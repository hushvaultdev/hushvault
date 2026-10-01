import { encryptSecret } from '../../src/crypto/envelope'
import { createPrefixedId } from '../../src/lib/auth'
import type { TestEnv } from './env'

/** Insert a secret with real envelope encryption (blob in KV, wrapped DEK in D1). */
export async function seedSecret(env: TestEnv, projectId: string, envId: string, name: string, value: string) {
  const id = createPrefixedId('sec')
  const { encryptedValue, wrappedDek } = await encryptSecret(value, env.ENCRYPTION_MASTER_KEY)
  await env.SECRETS_KV.put(`secret:${id}`, encryptedValue)
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, is_computed, template, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)',
  ).bind(id, projectId, envId, name, wrappedDek, 'v1', '[]', now, now).run()
  return id
}

/** Insert a computed secret: value comes from the template, no KV blob. */
export async function seedComputed(env: TestEnv, projectId: string, envId: string, name: string, template: string) {
  const id = createPrefixedId('sec')
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, is_computed, template, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
  ).bind(id, projectId, envId, name, '', 'v1', template, '[]', now, now).run()
  return id
}
