// Short-lived, read-only tokens for CI (issue #43).
//
// Issued by the OIDC exchange, never by a password or an API key. A CI token carries no user and no role: it
// names one organisation and one environment, and `requireAuth` lets it reach exactly one read endpoint. It is
// signed with JWT_SECRET like a session token but separated from one on BOTH sides and in two independent ways:
// it carries `kind: 'ci-env'` (which verifyJwt rejects outright) and a different audience, so neither verifier can
// ever be made to accept the other's token by adding a field.
import { createBase64Url, decodeBase64Url, timingSafeEqual } from './auth'

/** Long enough for a job step to fetch secrets, short enough that leaking a log line ages out fast. */
export const CI_TOKEN_TTL_SECONDS = 10 * 60

export type CiTokenPayload = {
  kind: 'ci-env'
  /** The rule that granted this token, for audit. */
  sub: string
  orgId: string
  envId: string
  iss: 'hushvault'
  aud: 'hushvault-ci'
  iat: number
  exp: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function sign(secret: string, data: string): Promise<string> {
  return createBase64Url(await crypto.subtle.sign('HMAC', await hmacKey(secret), textEncoder.encode(data)))
}

export async function signCiToken(
  input: { ruleId: string; orgId: string; envId: string },
  secret: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresIn: number; expiresAt: string }> {
  const iat = Math.floor(now.getTime() / 1000)
  const payload: CiTokenPayload = {
    kind: 'ci-env', sub: input.ruleId, orgId: input.orgId, envId: input.envId,
    iss: 'hushvault', aud: 'hushvault-ci', iat, exp: iat + CI_TOKEN_TTL_SECONDS,
  }
  const body = `${createBase64Url(textEncoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${createBase64Url(textEncoder.encode(JSON.stringify(payload)))}`
  return {
    token: `${body}.${await sign(secret, body)}`,
    expiresIn: CI_TOKEN_TTL_SECONDS,
    expiresAt: new Date((iat + CI_TOKEN_TTL_SECONDS) * 1000).toISOString(),
  }
}

/** Returns the payload for an authentic, unexpired CI token, otherwise null. Never throws. */
export async function verifyCiToken(token: string, secret: string, now: Date = new Date()): Promise<CiTokenPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  try {
    const header = JSON.parse(textDecoder.decode(decodeBase64Url(headerPart))) as { alg?: string; typ?: string }
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null
    if (!timingSafeEqual(await sign(secret, `${headerPart}.${payloadPart}`), signaturePart)) return null
    const payload = JSON.parse(textDecoder.decode(decodeBase64Url(payloadPart))) as CiTokenPayload
    if (payload.kind !== 'ci-env' || payload.iss !== 'hushvault' || payload.aud !== 'hushvault-ci') return null
    if (!payload.sub || !payload.orgId || !payload.envId) return null
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now.getTime() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
