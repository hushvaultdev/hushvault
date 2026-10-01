import { createPrefixedId } from '../../src/lib/auth'
import type { TestEnv } from './env'

/** Seed a secret row + KV blob + one history row + history blob. Returns ids and KV keys. */
export async function seedSecretWithHistory(env: TestEnv, projectId: string, envId: string) {
  const now = new Date().toISOString()
  const secretId = createPrefixedId('sec')
  const historyId = createPrefixedId('his')
  await env.DB.prepare(
    'INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(secretId, projectId, envId, `API_KEY_${secretId.slice(-6)}`, 'wrapped', 'v1', now, now).run()
  await env.DB.prepare('INSERT INTO secret_history (id, secret_id, wrapped_dek, key_version, changed_at) VALUES (?, ?, ?, ?, ?)')
    .bind(historyId, secretId, 'wrapped-old', 'v1', now).run()
  const secretKey = `secret:${secretId}`
  const historyKey = `secrethist:${historyId}`
  await env.SECRETS_KV.put(secretKey, 'blob')
  await env.SECRETS_KV.put(historyKey, 'old-blob')
  return { secretId, historyId, secretKey, historyKey }
}

export async function auditActions(env: TestEnv, orgId: string, resourceId?: string) {
  const sql = resourceId
    ? 'SELECT action, resource_id FROM audit_log WHERE org_id = ? AND resource_id = ?'
    : 'SELECT action, resource_id FROM audit_log WHERE org_id = ?'
  const res = await env.DB.prepare(sql).bind(...(resourceId ? [orgId, resourceId] : [orgId])).all<{ action: string; resource_id: string }>()
  return res.results.map((r) => r.action)
}
