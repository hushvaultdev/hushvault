import type { Env } from '../index'
import { sendEmail } from './email'
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

export type SyncNeedsAttentionNotification = {
  orgId: string
  /** Opaque sync_targets.id. */
  targetId: string
  /** Provider id (a known enum label, e.g. "cloudflare-workers"). */
  provider: string
  /** A fixed SyncErrorCode (e.g. "PROVIDER_AUTH"). Never secret, never free text. */
  errorCode: string
}

/**
 * Notify an organisation's owners that a sync target has stopped and needs a person (issue #98). Without this a
 * 2am failure is invisible until prod secrets go stale. Writes a durable audit row (resource id only, no metadata
 * so the audit-log rule is untouched) and emails each owner. The body carries ONLY non-secret facts — the opaque
 * target id, the provider, the fixed error code and a dashboard link — never a secret value, name or credential.
 * Never throws: email failures are swallowed by sendEmail and the owner lookup is guarded.
 */
export async function notifySyncNeedsAttention(env: Env, n: SyncNeedsAttentionNotification): Promise<void> {
  try {
    await writeAuditLog(env, {
      orgId: n.orgId,
      actorId: null,
      actorType: 'system',
      action: 'notify.sync_needs_attention',
      resourceType: 'sync_target',
      resourceId: n.targetId,
    })
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'notify.audit_failed', action: 'notify.sync_needs_attention' }))
  }

  let owners: { email: string }[] = []
  try {
    const rows = await env.DB.prepare(
      "SELECT u.email AS email FROM members m INNER JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner'",
    ).bind(n.orgId).all<{ email: string }>()
    owners = (rows.results ?? []).filter((r) => typeof r.email === 'string' && r.email.length > 0)
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'notify.owner_lookup_failed' }))
    return
  }
  if (owners.length === 0) return

  let origin = ''
  try { origin = new URL(env.WEB_APP_URL ?? '').origin } catch { origin = '' }
  const link = origin ? `${origin}/integrations` : 'your HushVault dashboard'
  const subject = 'HushVault: a secret sync needs attention'
  const text = [
    'A secret sync target has stopped and needs attention.',
    '',
    `Provider: ${n.provider}`,
    `Target: ${n.targetId}`,
    `Reason: ${n.errorCode}`,
    '',
    'Automatic sync for this target is paused until the problem is fixed (for example, rotate the',
    'connection credential, or correct the secret it rejected). Open your integrations dashboard:',
    link,
  ].join('\n')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<p>A secret sync target has stopped and needs attention.</p>`
    + `<ul><li>Provider: <code>${esc(n.provider)}</code></li><li>Target: <code>${esc(n.targetId)}</code></li><li>Reason: <code>${esc(n.errorCode)}</code></li></ul>`
    + `<p>Automatic sync for this target is paused until the problem is fixed. `
    + (origin ? `<a href="${esc(link)}">Open your integrations dashboard</a>.` : 'Open your HushVault integrations dashboard.') + `</p>`

  for (const owner of owners) await sendEmail(env, { to: owner.email, subject, text, html })
}
