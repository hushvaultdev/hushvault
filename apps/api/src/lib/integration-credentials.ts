// Reading an integration credential. Decrypts only inside a sync job; the plaintext is never logged or
// returned from an endpoint (issue #39). Every read is scoped to the organisation.
import { decryptCredentialWithRing, loadKeyRing } from '../crypto/envelope'
import type { Env } from '../index'

export async function readCredential(env: Env, orgId: string, connectionId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT encrypted_credential, wrapped_dek, key_version FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1',
  ).bind(connectionId, orgId).first<{ encrypted_credential: string; wrapped_dek: string; key_version: string }>()
  if (!row) return null
  try {
    return await decryptCredentialWithRing(row.encrypted_credential, row.wrapped_dek, row.key_version, loadKeyRing(env), { orgId, connectionId })
  } catch {
    return null // opaque: wrong key, tampering and swapped rows all look the same
  }
}
