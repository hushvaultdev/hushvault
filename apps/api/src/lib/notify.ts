import type { Env } from '../index'
import { writeAuditLog } from './security'

// Notification stub. Today it only writes an audit-log entry so the event is
// durable and visible in the dashboard; it is structured so email/Slack delivery
// can be wired in later without changing call sites.
//
// SECURITY: never pass a raw leaked token, key hash, or any secret material into
// these functions. Identify keys by their opaque id only.

export type KeyRevokedNotification = {
  orgId: string
  // Opaque api_keys.id of the revoked key. Never the raw token or key hash.
  apiKeyId: string
  // Machine-readable reason, e.g. "leaked_in_github".
  reason: string
  // Optional non-sensitive context (e.g. the public commit URL GitHub reported).
  source?: string | null
}

// Notify the org owner that an API key was revoked. Currently records an audit
// entry; the email/Slack channels are intentionally left as TODOs (no secrets,
// no network calls, no credentials embedded here).
export async function notifyKeyRevoked(env: Env, notification: KeyRevokedNotification): Promise<void> {
  // TODO(notify): deliver via email (org owner) once a transactional email
  // binding/provider is configured.
  // TODO(notify): deliver via Slack once an org-level Slack webhook is stored.
  // Both must look up the recipient by orgId and must never include the leaked
  // token, the key hash, or any secret value in the message body.

  await writeAuditLog(env, {
    orgId: notification.orgId,
    actorId: null,
    actorType: 'system',
    action: 'notify.api_key_revoked',
    resourceType: 'api_key',
    resourceId: notification.apiKeyId,
  })
}
