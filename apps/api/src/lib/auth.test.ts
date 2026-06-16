import { describe, expect, it } from 'vitest'
import {
  createApiKey,
  createBase64Url,
  createPrefixedId,
  decodeBase64Url,
  hashApiKey,
  hashPassword,
  signJwt,
  timingSafeEqual,
  verifyJwt,
  verifyPassword,
  type JwtPayload,
} from './auth'

const SECRET = 'test-jwt-signing-secret'

function basePayload(): Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'> {
  return { sub: 'usr_123', orgId: 'org_456', role: 'admin' }
}

describe('base64url encoding', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(40))
    const encoded = createBase64Url(bytes)
    const decoded = decodeBase64Url(encoded)
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })

  it('produces URL-safe output (no +, /, or = padding)', () => {
    // 0xfb 0xff encodes to "+/" in standard base64; ensure it is url-safe here.
    const encoded = createBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe('JWT sign/verify', () => {
  it('signs and verifies a valid token', async () => {
    const token = await signJwt(basePayload(), SECRET)
    const payload = await verifyJwt(token, SECRET)

    expect(payload.sub).toBe('usr_123')
    expect(payload.orgId).toBe('org_456')
    expect(payload.role).toBe('admin')
    expect(payload.iss).toBe('hushvault')
    expect(payload.aud).toBe('hushvault-api')
    expect(payload.exp).toBeGreaterThan(payload.iat)
  })

  it('produces a three-part JWT', async () => {
    const token = await signJwt(basePayload(), SECRET)
    expect(token.split('.')).toHaveLength(3)
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signJwt(basePayload(), SECRET)
    await expect(verifyJwt(token, 'wrong-secret')).rejects.toThrow('Invalid token signature')
  })

  it('rejects a tampered payload', async () => {
    const token = await signJwt(basePayload(), SECRET)
    const [header, , signature] = token.split('.')
    const forgedPayload = createBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ sub: 'attacker', orgId: 'org_456', role: 'owner', iss: 'hushvault', aud: 'hushvault-api', iat: 1, exp: 9999999999 }),
      ),
    )
    await expect(verifyJwt(`${header}.${forgedPayload}.${signature}`, SECRET)).rejects.toThrow()
  })

  it('rejects a malformed token', async () => {
    await expect(verifyJwt('only.two', SECRET)).rejects.toThrow('Invalid token format')
  })

  it('rejects an expired token', async () => {
    const token = await signJwt(basePayload(), SECRET, -10) // already expired
    await expect(verifyJwt(token, SECRET)).rejects.toThrow('Expired token')
  })

  it('rejects a token with a non-HS256 algorithm header', async () => {
    const header = createBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))
    const payload = createBase64Url(new TextEncoder().encode(JSON.stringify(basePayload())))
    await expect(verifyJwt(`${header}.${payload}.`, SECRET)).rejects.toThrow('Unsupported token')
  })
})

describe('password hashing (PBKDF2)', () => {
  it('hashes and verifies a correct password', async () => {
    const { salt, passwordHash } = await hashPassword('hunter2')
    expect(await verifyPassword('hunter2', salt, passwordHash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const { salt, passwordHash } = await hashPassword('hunter2')
    expect(await verifyPassword('wrong', salt, passwordHash)).toBe(false)
  })

  it('uses a random salt — same password hashes differently', async () => {
    const a = await hashPassword('samePassword')
    const b = await hashPassword('samePassword')
    expect(a.salt).not.toBe(b.salt)
    expect(a.passwordHash).not.toBe(b.passwordHash)
  })

  it('is deterministic when the salt is supplied', async () => {
    const first = await hashPassword('pw')
    const second = await hashPassword('pw', first.salt)
    expect(second.passwordHash).toBe(first.passwordHash)
  })
})

describe('API key generation & hashing', () => {
  it('creates a key with the hv_live_ prefix and matching hash', async () => {
    const { rawKey, keyHash } = await createApiKey()
    expect(rawKey.startsWith('hv_live_')).toBe(true)
    expect(await hashApiKey(rawKey)).toBe(keyHash)
  })

  it('generates unique keys', async () => {
    const a = await createApiKey()
    const b = await createApiKey()
    expect(a.rawKey).not.toBe(b.rawKey)
    expect(a.keyHash).not.toBe(b.keyHash)
  })

  it('hashApiKey is deterministic', async () => {
    const { rawKey } = await createApiKey()
    expect(await hashApiKey(rawKey)).toBe(await hashApiKey(rawKey))
  })
})

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('createPrefixedId', () => {
  it('applies the given prefix', () => {
    expect(createPrefixedId('sec').startsWith('sec_')).toBe(true)
  })

  it('generates unique ids', () => {
    expect(createPrefixedId('usr')).not.toBe(createPrefixedId('usr'))
  })

  it('produces url-safe id bodies', () => {
    const body = createPrefixedId('org').slice('org_'.length)
    expect(body).not.toMatch(/[+/=]/)
  })
})
