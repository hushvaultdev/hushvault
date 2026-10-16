const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type JwtPayload = {
  sub: string
  orgId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  iss: 'hushvault'
  aud: 'hushvault-api'
  exp: number
  iat: number
}

export function createBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  for (const byte of input) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)

  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encodeJson(value: unknown): string {
  return createBase64Url(textEncoder.encode(JSON.stringify(value)))
}

function decodeJson<T>(value: string): T {
  return JSON.parse(textDecoder.decode(decodeBase64Url(value))) as T
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'>, secret: string, ttlSeconds = 60 * 60 * 24 * 7, issuedAt?: number): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat = issuedAt ?? Math.floor(Date.now() / 1000)
  const body: JwtPayload = {
    ...payload,
    iss: 'hushvault',
    aud: 'hushvault-api',
    iat,
    exp: iat + ttlSeconds,
  }

  const unsigned = `${encodeJson(header)}.${encodeJson(body)}`
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(secret), textEncoder.encode(unsigned))

  return `${unsigned}.${createBase64Url(signature)}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid token format')
  }

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const header = decodeJson<{ alg?: string; typ?: string }>(headerPart)
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new Error('Unsupported token')
  }

  const unsigned = `${headerPart}.${payloadPart}`
  const signature = decodeBase64Url(signaturePart)
  const verified = await crypto.subtle.verify('HMAC', await importHmacKey(secret), signature, textEncoder.encode(unsigned))
  if (!verified) {
    throw new Error('Invalid token signature')
  }

  const payload = decodeJson<JwtPayload>(payloadPart)
  // A scoped CI token is signed with the same secret and must never be accepted as a user session, even if it
  // later grows a `role`-shaped field. See lib/ci-tokens.ts.
  if ((payload as { kind?: unknown }).kind !== undefined) throw new Error('Unsupported token')
  if (!payload.sub || !payload.orgId || !payload.role || payload.iss !== 'hushvault' || payload.aud !== 'hushvault-api' || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired token')
  }

  return payload
}

/**
 * PBKDF2-HMAC-SHA256 iteration count for NEW hashes (sign-up, password reset) — OWASP
 * Password Storage Cheat Sheet's current recommendation. Measured cost on local workerd:
 * ~278ms (see docs/ENCRYPTION.md "PBKDF2 iteration count"), well under 1% of the Workers
 * Paid plan's default 30s per-request CPU budget. Raised from the historical 100,000 in
 * issue #89; migration 0022 added `users.password_iterations` so existing hashes keep
 * verifying at their original count and upgrade transparently on next sign-in.
 */
export const PASSWORD_ITERATIONS = 600_000

export async function hashPassword(
  password: string,
  options: { saltBase64?: string; iterations?: number } = {},
): Promise<{ salt: string; passwordHash: string; iterations: number }> {
  const salt = options.saltBase64 ? decodeBase64Url(options.saltBase64) : crypto.getRandomValues(new Uint8Array(16))
  const iterations = options.iterations ?? PASSWORD_ITERATIONS
  const baseKey = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    256,
  )

  return {
    salt: createBase64Url(salt),
    passwordHash: createBase64Url(derivedBits),
    iterations,
  }
}

/**
 * Verify a password at the EXACT iteration count the stored hash was derived with. The caller
 * must pass the user's `password_iterations` column, never let it default: a drift between
 * stored and asserted count silently breaks every pre-migration user's login. On a successful
 * verify where `iterations < PASSWORD_ITERATIONS`, the caller should re-hash and UPDATE the row
 * (the transparent-upgrade path — see routes/auth.ts).
 */
export async function verifyPassword(password: string, saltBase64: string, expectedHash: string, iterations: number): Promise<boolean> {
  const { passwordHash } = await hashPassword(password, { saltBase64, iterations })
  return timingSafeEqual(passwordHash, expectedHash)
}

export async function createApiKey(): Promise<{ rawKey: string; keyHash: string }> {
  const raw = `hv_live_${createBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
  const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(raw))

  return {
    rawKey: raw,
    keyHash: createBase64Url(hashBuffer),
  }
}

export async function hashApiKey(rawKey: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(rawKey))
  return createBase64Url(hashBuffer)
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }

  return result === 0
}

export function createPrefixedId(prefix: string): string {
  return `${prefix}_${createBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`
}