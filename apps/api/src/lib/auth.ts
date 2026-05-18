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

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'>, secret: string, ttlSeconds = 60 * 60 * 24 * 7): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat = Math.floor(Date.now() / 1000)
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
  if (!payload.sub || !payload.orgId || !payload.role || payload.iss !== 'hushvault' || payload.aud !== 'hushvault-api' || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired token')
  }

  return payload
}

export async function hashPassword(password: string, saltBase64?: string): Promise<{ salt: string; passwordHash: string }> {
  const salt = saltBase64 ? decodeBase64Url(saltBase64) : crypto.getRandomValues(new Uint8Array(16))
  const baseKey = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    baseKey,
    256,
  )

  return {
    salt: createBase64Url(salt),
    passwordHash: createBase64Url(derivedBits),
  }
}

export async function verifyPassword(password: string, saltBase64: string, expectedHash: string): Promise<boolean> {
  const { passwordHash } = await hashPassword(password, saltBase64)
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