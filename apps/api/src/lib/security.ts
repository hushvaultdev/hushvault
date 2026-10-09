import type { Env } from '../index'
import { KeyRingError } from '../crypto/envelope'

const textEncoder = new TextEncoder()

export const MAX_SECRET_VALUE_BYTES = 65_536
export const MAX_SECRET_KEY_LENGTH = 256

export class SecretTooLargeError extends Error {
  constructor() {
    super('Secret value exceeds 64KB limit')
    this.name = 'SecretTooLargeError'
  }
}

/** Redact secret-bearing path segments (share tokens) and drop the query string. */
export function redactPath(rawPath: string): string {
  const path = rawPath.split('?')[0] ?? ''
  return path.replace(/^(\/api\/share\/)[^/]+/, '$1:token')
}

export function assertSecretSize(value: string): void {
  const bytes = textEncoder.encode(value).byteLength
  if (bytes > MAX_SECRET_VALUE_BYTES) {
    throw new SecretTooLargeError()
  }
}

/**
 * The bounded shape of `AuditEntry.metadata` (issue #96, .claude/rules/audit-log.md): a flat object
 * of fixed server-set keys whose values are primitives only. Deliberately NOT `unknown` or a nested
 * type — the type is the first line of the rule that audit metadata is small, non-secret and not
 * caller-supplied free text. It is never the place a secret value, DEK, token or key is written.
 */
export type AuditMetadata = Record<string, string | number | boolean | null>

export type AuditEntry = {
  orgId: string
  actorId?: string | null
  actorType: 'user' | 'api_key' | 'system'
  action: string
  resourceType?: string | null
  resourceId?: string | null
  ip?: string | null
  userAgent?: string | null
  /**
   * Optional bounded context for this event — e.g. a role change stores `{ from, to }`. See
   * `AuditMetadata`. Serialised as JSON for the `metadata` column; omitted/undefined stores NULL.
   */
  metadata?: AuditMetadata | null
}

/**
 * Serialise `metadata` to the JSON string the column stores, or null for none. The runtime guard
 * backs up the type for the one chokepoint every audit row flows through: a non-primitive value is
 * a programming error (the type forbids it), and failing loudly here is better than letting a
 * nested object — the shape a secret value would eventually arrive wrapped in — reach the trail.
 * Values are never inspected for their content: the no-secret rule is a discipline the type and
 * this guard support, not something they can prove.
 */
export function serialiseAuditMetadata(metadata: AuditMetadata | null | undefined): string | null {
  if (metadata === null || metadata === undefined) return null
  for (const value of Object.values(metadata)) {
    const ok = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    if (!ok) throw new TypeError('audit metadata values must be string, number, boolean or null')
  }
  return JSON.stringify(metadata)
}

/**
 * The audit insert as a statement, for a caller that must write several rows in one D1 call
 * (an account-level event fans out to every org the person belongs to — issue #82). Use
 * `writeAuditLog` for the single-row case; this exists so that fan-out does not become one
 * subrequest per row on an auth path.
 */
export function auditLogStatement(env: Env, entry: AuditEntry) {
  return env.DB.prepare(
    'INSERT INTO audit_log (id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    `audit_${crypto.randomUUID().replace(/-/g, '')}`,
    entry.orgId,
    // A CI token has no person behind it: an empty actor id is stored as NULL (actor_id references users).
    entry.actorId || null,
    entry.actorType,
    entry.action,
    entry.resourceType ?? null,
    entry.resourceId ?? null,
    entry.ip ?? null,
    entry.userAgent ?? null,
    serialiseAuditMetadata(entry.metadata),
    new Date().toISOString(),
  )
}

export async function writeAuditLog(env: Env, entry: AuditEntry): Promise<void> {
  await auditLogStatement(env, entry).run()
}

/**
 * The client IP recorded in the audit log. Only cf-connecting-ip is trusted: it is set by
 * Cloudflare's edge and cannot be forged by the caller, while x-forwarded-for is
 * client-controlled and would let anyone write a chosen IP into another org's audit trail.
 * Same rule as the rate limiter (middleware/rate-limit.ts) and the OIDC refetch budget.
 */
export function getRequestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return c.req.header('cf-connecting-ip') ?? null
}
/**
 * One structured line for an operational event. Codes, counts and labels only — never a secret
 * value, a key, a DEK, a token or anything a caller supplied. These lines are what an operator
 * alerts on, so an event that means "a control just stopped working" must emit one.
 */
export function logEvent(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }))
}

/** Log a key-ring configuration problem: error code and key version label only, never key material. */
export function logKeyRingError(err: unknown): void {
  if (err instanceof KeyRingError) {
    console.error(JSON.stringify({ level: 'error', code: err.code, keyVersion: err.version ?? null }))
  }
}
