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

export async function writeAuditLog(env: Env, entry: {
  orgId: string
  actorId?: string | null
  actorType: 'user' | 'api_key' | 'system'
  action: string
  resourceType?: string | null
  resourceId?: string | null
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (id, org_id, actor_id, actor_type, action, resource_type, resource_id, ip, user_agent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    new Date().toISOString(),
  ).run()
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
