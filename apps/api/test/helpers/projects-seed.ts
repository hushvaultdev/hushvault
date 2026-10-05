import { createPrefixedId } from '../../src/lib/auth'
import type { TestEnv } from './env'

/**
 * Seed a secret row at blob revision 2, with the blob for every revision it has pointed at.
 *
 * Was `seedSecretWithHistory`, which also seeded a `secret_history` row and a
 * `secrethist:{historyId}` copy. Both are gone (issue #84); what a project delete has to clean
 * up is now exactly the secret's own revisions, which is what this seeds.
 */
export async function seedSecretWithRevisions(env: TestEnv, projectId: string, envId: string) {
  const now = new Date().toISOString()
  const secretId = createPrefixedId('sec')
  await env.DB.prepare(
    'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, blob_rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)',
  ).bind(secretId, projectId, envId, `API_KEY_${secretId.slice(-6)}`, 'wrapped', 'v1', now, now).run()
  const blobKeys = [`secret:${secretId}`, `secret:${secretId}:1`, `secret:${secretId}:2`]
  for (const key of blobKeys) await env.SECRETS_KV.put(key, 'blob')
  return { secretId, secretKey: blobKeys[2], blobKeys }
}

export async function auditActions(env: TestEnv, orgId: string, resourceId?: string) {
  const sql = resourceId
    ? 'SELECT action, resource_id FROM audit_log WHERE org_id = ? AND resource_id = ?'
    : 'SELECT action, resource_id FROM audit_log WHERE org_id = ?'
  const res = await env.DB.prepare(sql).bind(...(resourceId ? [orgId, resourceId] : [orgId])).all<{ action: string; resource_id: string }>()
  return res.results.map((r) => r.action)
}
