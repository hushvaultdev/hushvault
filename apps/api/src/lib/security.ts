import type { Env } from '../index'

const textEncoder = new TextEncoder()

export const MAX_SECRET_VALUE_BYTES = 65_536
export const MAX_SECRET_KEY_LENGTH = 256

export function assertSecretSize(value: string): void {
  const bytes = textEncoder.encode(value).byteLength
  if (bytes > MAX_SECRET_VALUE_BYTES) {
    throw new Error('Secret value exceeds 64KB limit')
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
    entry.actorId ?? null,
    entry.actorType,
    entry.action,
    entry.resourceType ?? null,
    entry.resourceId ?? null,
    entry.ip ?? null,
    entry.userAgent ?? null,
    new Date().toISOString(),
  ).run()
}

export function getRequestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null
}