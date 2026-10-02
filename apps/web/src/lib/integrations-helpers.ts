import { FREE_PLAN_MAX_SYNC_TARGETS, SYNC_SCHEDULE_OPTIONS, type SyncAutoSync, type SyncPlanDto, type SyncRunDto, type SyncTargetDto } from '@hushvault/shared/integrations'

import { ApiError } from './api'

// Pure helpers for the Integrations page. Nothing here touches secrets or credentials.

export const DOCS_BASE = 'https://github.com/hushvaultdev/hushvault/blob/main/docs/integrations'

export function docsUrl(providerId: string): string {
  return `${DOCS_BASE}/${encodeURIComponent(providerId)}.md`
}

/** Minimal-permission guidance shown next to the credential input. */
export function permissionGuidance(providerId: string): string {
  if (providerId === 'cloudflare-workers') {
    return (
      'Create a Cloudflare API token limited to this one account with only the "Workers Scripts: Edit" permission. ' +
      'Nothing broader is needed. The token is stored encrypted and can never be shown again.'
    )
  }
  return 'Create a token with only the permissions this integration needs. The credential is stored encrypted and can never be shown again.'
}

const ERROR_MESSAGES: Record<string, string> = {
  CREDENTIAL_REJECTED: 'The provider rejected this credential. Check that the token is valid and has the permissions listed above.',
  UNSUPPORTED_PROVIDER: 'This provider cannot be connected in this deployment.',
  LIMIT_REACHED: 'The connection limit for your organisation has been reached. Revoke an unused connection first.',
  PLAN_LIMIT: `Your plan allows at most ${FREE_PLAN_MAX_SYNC_TARGETS} sync targets. Remove one or upgrade to add more.`,
  SYNC_BLOCKED: 'This run is blocked. Use Preview to see which names need fixing.',
  PROVIDER_AUTH: 'The provider rejected the stored credential. Rotate the credential on the connection, then run again.',
  PROVIDER_RATE_LIMIT: 'The provider is rate limiting requests. Wait a minute and try again.',
  PROVIDER_VALIDATION: 'The provider refused a value or name. Use Preview to check names and sizes, then fix the secret or the name filter.',
  PROVIDER_ERROR: 'The provider returned an error. Try again shortly.',
  TARGET_NOT_FOUND: 'The target resource (for example the Worker) was not found. Check it still exists, or edit the target to point at the right one.',
  COMPUTED_ERROR: 'A computed secret could not be resolved. Fix its ${NAME} references in the project, then run again.',
  CREDENTIAL_UNAVAILABLE: 'The stored credential could not be used. Rotate the credential on the connection, then run again.',
  DECRYPTION_FAILED: 'HushVault could not decrypt something it needed. Contact support if this repeats.',
  TARGET_NOT_ALLOWED: 'This Worker cannot be a sync target (it is protected or in a blocked account). Remove the target.',
  EMPTY_VALUE: 'A secret has an empty value, which Cloudflare may reject. Give it a value or filter it out.',
  TIMEOUT: 'The run timed out before finishing. Run again; partial progress is kept.',
}

/** Guidance for a failed or partial run's error code, or null when there is none to show. */
export function runErrorGuidance(code: string | null | undefined): string | null {
  if (!code) return null
  return ERROR_MESSAGES[code] ?? `The run stopped with ${code}. Try again shortly.`
}

/** Maps API failures to a short message. Never includes request bodies, so no credential can leak. */
export function describeApiError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  // CONFLICT is context dependent (label in use, resource already a target), so use the API's own message.
  if (err.code === 'CONFLICT') return err.message || 'That conflicts with existing data.'
  const known = ERROR_MESSAGES[err.code]
  if (known) return known
  if (err.status === 403) return 'Only organisation admins can manage integrations, and only from a signed-in session (not an API key).'
  if (err.status === 429) return 'Too many requests. Wait a moment and try again.'
  if (err.status === 409) return err.message || 'That conflicts with existing data.'
  if (err.status === 422) return err.message || 'The request could not be processed.'
  if (err.status === 0) return err.message
  if (err.status === 502) return ERROR_MESSAGES['PROVIDER_ERROR'] ?? fallback
  if (err.status >= 500) return 'The server had a problem. Try again shortly.'
  return err.message || fallback
}

export interface PlanGroup {
  key: 'create' | 'update' | 'delete' | 'skip' | 'conflict'
  label: string
  names: string[]
}

const GROUP_LABELS: Record<PlanGroup['key'], string> = {
  create: 'Will create',
  update: 'Will update',
  delete: 'Will delete',
  skip: 'Unchanged / skipped',
  conflict: 'Conflict (exists on target, not created by HushVault, left untouched)',
}

/** Non-empty plan groups in display order. Names only. */
export function groupPlan(plan: SyncPlanDto): PlanGroup[] {
  const keys: PlanGroup['key'][] = ['create', 'update', 'delete', 'skip', 'conflict']
  return keys.filter((k) => plan[k].length > 0).map((k) => ({ key: k, label: GROUP_LABELS[k], names: plan[k] }))
}

export function planIsEmpty(plan: SyncPlanDto): boolean {
  return groupPlan(plan).length === 0 && plan.blockers.length === 0
}

const BLOCKER_LABELS: Record<string, string> = {
  TOO_MANY_ITEMS: 'Too many secrets for this provider',
  VALUE_TOO_LARGE: 'Value too large for this provider',
  NAME_INVALID: 'Name not allowed by this provider',
}

export function blockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? `Cannot run (${code})`
}

export function runCountsText(counts: SyncRunDto['counts']): string {
  return `${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted, ${counts.skipped} skipped, ${counts.failed} failed`
}

/** Comma or whitespace separated names to a de-duplicated list. */
export function parseNameList(input: string): string[] {
  const seen = new Set<string>()
  for (const part of input.split(/[\s,]+/)) {
    if (part) seen.add(part)
  }
  return [...seen]
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Returns an error message, or null when the prefix and deny entries look valid. */
export function validateNameFilter(prefix: string, deny: string[]): string | null {
  if (prefix.length > 64) return 'Prefix is too long (64 characters at most).'
  if (prefix && !NAME_PATTERN.test(prefix)) return 'Prefix may contain letters, digits and underscores only, and cannot start with a digit.'
  if (deny.length > 200) return 'Too many deny-list entries (200 at most).'
  for (const name of deny) {
    if (!NAME_PATTERN.test(name)) return `"${name}" is not a valid secret name.`
  }
  return null
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/i
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/

export function validateAccountId(value: string): string | null {
  return ACCOUNT_ID.test(value) ? null : 'Account ID must be the 32-character hex ID from the Cloudflare dashboard.'
}

export function validateScriptName(value: string): string | null {
  return SCRIPT_NAME.test(value) ? null : 'Worker name may contain letters, digits, dashes and underscores (63 characters at most).'
}

export function validateLabel(value: string): string | null {
  const length = value.trim().length
  return length >= 1 && length <= 64 ? null : 'Label must be 1 to 64 characters.'
}

export function validateCredential(value: string): string | null {
  return value.length >= 8 && value.length <= 4096 ? null : 'Credential must be 8 to 4096 characters.'
}

export function isAdminRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner'
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString()
}

export function targetNeedsAttention(target: SyncTargetDto): boolean {
  return target.status === 'needs_attention'
}

/** One-line description of a target's destination, e.g. the Worker name. */
export function resourceText(resource: Record<string, string>): string {
  return resource['scriptName'] ?? Object.values(resource).join(' / ')
}

const SCHEDULE_LABELS: Record<number, string> = {
  15: 'Every 15 minutes',
  60: 'Hourly',
  360: 'Every 6 hours',
  1440: 'Daily',
}

/** Select options for the schedule: value '' means off. */
export function scheduleOptions(): { value: string; label: string }[] {
  return [
    { value: '', label: 'Off' },
    ...SYNC_SCHEDULE_OPTIONS.map((m) => ({ value: String(m), label: SCHEDULE_LABELS[m] ?? `Every ${m} minutes` })),
  ]
}

/** Select value ('' = off) to API value. Unknown values fall back to null (off). */
export function parseScheduleValue(value: string): number | null {
  const n = Number(value)
  return (SYNC_SCHEDULE_OPTIONS as readonly number[]).includes(n) ? n : null
}

/** API value to select value; an unexpected number maps to off so the select stays controlled. */
export function scheduleValue(minutes: number | null | undefined): string {
  return minutes != null && (SYNC_SCHEDULE_OPTIONS as readonly number[]).includes(minutes) ? String(minutes) : ''
}

/** Short text for a target row, e.g. "on change, hourly" or "off". Tolerates a missing setting from an older API. */
export function autoSyncText(autoSync: SyncAutoSync | undefined): string {
  if (!autoSync) return 'off'
  const parts: string[] = []
  if (autoSync.onChange) parts.push('on change')
  if (autoSync.scheduleMinutes != null) parts.push((SCHEDULE_LABELS[autoSync.scheduleMinutes] ?? `every ${autoSync.scheduleMinutes} minutes`).toLowerCase())
  return parts.length > 0 ? parts.join(', ') : 'off'
}

const TRIGGER_LABELS: Record<string, string> = { manual: 'Manual', change: 'Secret change', schedule: 'Schedule' }

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger
}

/** "Will retry at <time>" for a run that is waiting to retry, else null. */
export function retryText(nextRetryAt: string | null | undefined): string | null {
  if (!nextRetryAt) return null
  const d = new Date(nextRetryAt)
  return Number.isNaN(d.getTime()) ? null : `Will retry at ${d.toLocaleString()}`
}

/** What to do about a target in the needs-attention state. */
export function needsAttentionSteps(): string[] {
  return [
    'Rotate the connection credential (Connections, Rotate credential) if the provider rejected it or it expired.',
    'Edit the target if the Worker was renamed or moved, or remove the target if it is no longer needed.',
    'Then use Run now. A successful run clears this state; automatic runs are paused until then.',
  ]
}
