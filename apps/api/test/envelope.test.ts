import { describe, expect, it, vi } from 'vitest'
import {
  KeyRingError,
  decryptSecret,
  decryptSecretWithRing,
  encryptSecret,
  encryptSecretWithRing,
  isValidKeyVersion,
  loadKeyRing,
  makeKeyCheck,
  rewrapDek,
  verifyKeyCheck,
} from '../src/crypto/envelope'

const b64 = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64')

function ringEnv(extra: Record<string, string | undefined> = {}) {
  return { ENCRYPTION_MASTER_KEY: b64(32), ...extra }
}

const CTX = { projectId: 'prj_1', envId: 'env_1', secretId: 'sec_1' }

describe('legacy single-key envelope', () => {
  it('round-trips and uses a fresh DEK and IV each time', async () => {
    const key = b64(32)
    const a = await encryptSecret('value', key)
    const b = await encryptSecret('value', key)
    expect(a.encryptedValue).not.toBe(b.encryptedValue)
    expect(a.wrappedDek).not.toBe(b.wrappedDek)
    expect(await decryptSecret(a.encryptedValue, a.wrappedDek, key)).toBe('value')
  })
})

describe('key ring', () => {
  it('validates version labels', () => {
    for (const ok of ['v1', 'v2', 'v10', 'v9999']) expect(isValidKeyVersion(ok)).toBe(true)
    for (const bad of ['', 'v0', 'v01', 'V1', 'v10000', 'v1;drop', '1', 'v-1', 'v1 ']) expect(isValidKeyVersion(bad)).toBe(false)
  })

  it('defaults the active version to v1 and rejects an invalid active label', () => {
    expect(loadKeyRing(ringEnv()).activeVersion).toBe('v1')
    expect(loadKeyRing(ringEnv({ ENCRYPTION_ACTIVE_KEY_VERSION: ' v2 ' })).activeVersion).toBe('v2')
    expect(() => loadKeyRing(ringEnv({ ENCRYPTION_ACTIVE_KEY_VERSION: 'latest' }))).toThrow(KeyRingError)
  })

  it('reads v1 from ENCRYPTION_MASTER_KEY and vN from ENCRYPTION_KEY_VN', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32) })
    const ring = loadKeyRing(env)
    expect(ring.has('v1')).toBe(true)
    expect(ring.has('v2')).toBe(true)
    expect(ring.has('v3')).toBe(false)
    expect(ring.has('bogus')).toBe(false)
    await expect(ring.getKey('v3')).rejects.toMatchObject({ code: 'KEY_VERSION_UNAVAILABLE', version: 'v3' })
  })

  it('rejects keys that are not exactly 32 bytes', async () => {
    for (const bad of [b64(16), b64(24), b64(33), 'not base64 !!', '']) {
      const ring = loadKeyRing({ ENCRYPTION_MASTER_KEY: bad })
      await expect(ring.getKey('v1')).rejects.toBeInstanceOf(KeyRingError)
    }
  })

  it('encrypts under the active version and decrypts by the row version', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32), ENCRYPTION_ACTIVE_KEY_VERSION: 'v2' })
    const ring = loadKeyRing(env)
    const written = await encryptSecretWithRing('hello', ring, CTX)
    expect(written.keyVersion).toBe('v2')
    expect(await decryptSecretWithRing(written.encryptedValue, written.wrappedDek, 'v2', ring, CTX, 2)).toBe('hello')
    // Same wrapped DEK under the wrong version label fails (opaque GCM error), never plaintext.
    await expect(decryptSecretWithRing(written.encryptedValue, written.wrappedDek, 'v1', ring, CTX, 2)).rejects.toThrow()
  })

  it('a value written under v1 stays readable after the active version moves to v2', async () => {
    const base = ringEnv({ ENCRYPTION_KEY_V2: b64(32) })
    const v1 = await encryptSecretWithRing('legacy', loadKeyRing(base), CTX)
    expect(v1.keyVersion).toBe('v1')
    const later = loadKeyRing({ ...base, ENCRYPTION_ACTIVE_KEY_VERSION: 'v2' })
    expect(await decryptSecretWithRing(v1.encryptedValue, v1.wrappedDek, 'v1', later, CTX, 2)).toBe('legacy')
  })

  it('detects tampering with the value or the wrapped DEK', async () => {
    const ring = loadKeyRing(ringEnv())
    const w = await encryptSecretWithRing('x', ring, CTX)
    const flip = (s: string) => {
      const [tag, iv, ct] = s.split(':') as [string, string, string]
      const bytes = Buffer.from(ct, 'base64')
      bytes[0] = (bytes[0] ?? 0) ^ 1
      return `${tag}:${iv}:${bytes.toString('base64')}`
    }
    await expect(decryptSecretWithRing(flip(w.encryptedValue), w.wrappedDek, 'v1', ring, CTX, 2)).rejects.toThrow()
    await expect(decryptSecretWithRing(w.encryptedValue, flip(w.wrappedDek), 'v1', ring, CTX, 2)).rejects.toThrow()
  })
})

describe('rewrapDek', () => {
  it('moves a DEK to a new key without changing the ciphertext, using a fresh IV', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32) })
    const ring = loadKeyRing(env)
    const v1 = await encryptSecretWithRing('rotate me', ring, CTX)
    const rewrapped = await rewrapDek(v1.wrappedDek, await ring.getKey('v1'), await ring.getKey('v2'), CTX.secretId)
    expect(rewrapped).not.toBe(v1.wrappedDek)
    expect(rewrapped.split(':')[1]).not.toBe(v1.wrappedDek.split(':')[1])
    // The KV blob is untouched and now decrypts with ONLY the v2 key.
    const onlyV2 = loadKeyRing({ ENCRYPTION_MASTER_KEY: '', ENCRYPTION_KEY_V2: env.ENCRYPTION_KEY_V2, ENCRYPTION_ACTIVE_KEY_VERSION: 'v2' })
    expect(await decryptSecretWithRing(v1.encryptedValue, rewrapped, 'v2', onlyV2, CTX, 2)).toBe('rotate me')
  })

  it('throws on a wrong source key or a corrupt wrapped DEK', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32), ENCRYPTION_KEY_V3: b64(32) })
    const ring = loadKeyRing(env)
    const v1 = await encryptSecretWithRing('x', ring, CTX)
    await expect(rewrapDek(v1.wrappedDek, await ring.getKey('v3'), await ring.getKey('v2'), CTX.secretId)).rejects.toThrow()
    await expect(rewrapDek('garbage', await ring.getKey('v1'), await ring.getKey('v2'), CTX.secretId)).rejects.toThrow()
  })
})

describe('key check values', () => {
  it('verify only under the key that made them and never contain the key', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32) })
    const ring = loadKeyRing(env)
    const k1 = await ring.getKey('v1')
    const k2 = await ring.getKey('v2')
    const check = await makeKeyCheck(k1)
    expect(await verifyKeyCheck(k1, check)).toBe(true)
    expect(await verifyKeyCheck(k2, check)).toBe(false)
    expect(await verifyKeyCheck(k1, 'not-a-check-value')).toBe(false)
    expect(check).not.toContain(env.ENCRYPTION_MASTER_KEY)
  })
})

describe('no key material in errors or logs', () => {
  it('KeyRingError messages carry only a code and a version label', async () => {
    const secretKey = b64(16)
    const ring = loadKeyRing({ ENCRYPTION_MASTER_KEY: secretKey })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await ring.getKey('v1')
      expect.unreachable()
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secretKey)
      expect(JSON.stringify(err)).not.toContain(secretKey)
    }
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('AAD context binding (v2)', () => {
  const OTHER = { projectId: 'prj_1', envId: 'env_2', secretId: 'sec_1' }

  it('rejects a blob moved to another environment, project or secret id', async () => {
    const ring = loadKeyRing(ringEnv())
    const w = await encryptSecretWithRing('prod-value', ring, CTX)
    for (const ctx of [OTHER, { ...CTX, projectId: 'prj_2' }, { ...CTX, secretId: 'sec_2' }]) {
      await expect(decryptSecretWithRing(w.encryptedValue, w.wrappedDek, 'v1', ring, ctx, 2)).rejects.toThrow()
    }
  })

  it('rejects a wrapped DEK from another secret (cross-record swap)', async () => {
    const ring = loadKeyRing(ringEnv())
    const a = await encryptSecretWithRing('a', ring, CTX)
    const b = await encryptSecretWithRing('b', ring, { ...CTX, secretId: 'sec_2' })
    await expect(decryptSecretWithRing(a.encryptedValue, b.wrappedDek, 'v1', ring, CTX, 2)).rejects.toThrow()
    await expect(decryptSecretWithRing(b.encryptedValue, b.wrappedDek, 'v1', ring, CTX, 2)).rejects.toThrow()
  })

  it('does not downgrade: a legacy blob is refused for an enc_version 2 row, and vice versa', async () => {
    const env = ringEnv()
    const ring = loadKeyRing(env)
    const legacy = await encryptSecret('x', env.ENCRYPTION_MASTER_KEY)
    const v2 = await encryptSecretWithRing('x', ring, CTX)
    await expect(decryptSecretWithRing(legacy.encryptedValue, legacy.wrappedDek, 'v1', ring, CTX, 2)).rejects.toThrow()
    await expect(decryptSecretWithRing(v2.encryptedValue, v2.wrappedDek, 'v1', ring, CTX, 1)).rejects.toThrow()
  })

  it('reads legacy rows until ENFORCE_AAD=true, then refuses them', async () => {
    const env = ringEnv()
    const legacy = await encryptSecret('old', env.ENCRYPTION_MASTER_KEY)
    expect(await decryptSecretWithRing(legacy.encryptedValue, legacy.wrappedDek, 'v1', loadKeyRing(env), CTX, 1)).toBe('old')
    await expect(
      decryptSecretWithRing(legacy.encryptedValue, legacy.wrappedDek, 'v1', loadKeyRing({ ...env, ENFORCE_AAD: 'true' }), CTX, 1),
    ).rejects.toThrow()
  })

  it('re-wrap keeps the binding: the new wrap only opens for the same secret id', async () => {
    const env = ringEnv({ ENCRYPTION_KEY_V2: b64(32) })
    const ring = loadKeyRing(env)
    const w = await encryptSecretWithRing('x', ring, CTX)
    const next = await rewrapDek(w.wrappedDek, await ring.getKey('v1'), await ring.getKey('v2'), CTX.secretId)
    expect(await decryptSecretWithRing(w.encryptedValue, next, 'v2', ring, CTX, 2)).toBe('x')
    await expect(rewrapDek(w.wrappedDek, await ring.getKey('v1'), await ring.getKey('v2'), 'sec_other')).rejects.toThrow()
  })
})
