import { describe, expect, it } from 'vitest'
import {
  decrypt,
  decryptSecret,
  deriveKeyFromPassword,
  encrypt,
  encryptSecret,
  exportKey,
  generateDek,
  generateSalt,
  importKey,
} from './envelope'

/**
 * Generate a fresh, random 256-bit master key (base64) for each test run.
 * Never hardcode a real key — always derive from crypto.getRandomValues.
 */
function randomMasterKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of raw) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe('envelope encryption — low-level encrypt/decrypt', () => {
  it('round-trips plaintext through a single CryptoKey', async () => {
    const dek = await generateDek()
    const plaintext = 'super-secret-database-url'

    const encrypted = await encrypt(plaintext, dek)
    const decrypted = await decrypt(encrypted, dek)

    expect(decrypted).toBe(plaintext)
  })

  it('produces the "iv:ciphertext" wire format', async () => {
    const dek = await generateDek()
    const encrypted = await encrypt('value', dek)

    const parts = encrypted.split(':')
    expect(parts).toHaveLength(2)
    // 12-byte IV base64-encodes to 16 chars
    expect(parts[0]).toHaveLength(16)
    expect(parts[1]!.length).toBeGreaterThan(0)
  })

  it('uses a random IV — same plaintext yields different ciphertexts', async () => {
    const dek = await generateDek()
    const a = await encrypt('identical', dek)
    const b = await encrypt('identical', dek)

    expect(a).not.toBe(b)
    // IVs (first segment) should differ
    expect(a.split(':')[0]).not.toBe(b.split(':')[0])
    // ...yet both decrypt to the same plaintext
    expect(await decrypt(a, dek)).toBe('identical')
    expect(await decrypt(b, dek)).toBe('identical')
  })

  it('round-trips unicode and empty strings', async () => {
    const dek = await generateDek()
    for (const value of ['', '🔐 émoji ✓', 'a'.repeat(10_000)]) {
      expect(await decrypt(await encrypt(value, dek), dek)).toBe(value)
    }
  })

  it('rejects a malformed encrypted string', async () => {
    const dek = await generateDek()
    await expect(decrypt('not-a-valid-format', dek)).rejects.toThrow('Invalid encrypted format')
  })

  it('fails to decrypt with the wrong key', async () => {
    const dek = await generateDek()
    const otherDek = await generateDek()
    const encrypted = await encrypt('secret', dek)

    await expect(decrypt(encrypted, otherDek)).rejects.toThrow()
  })

  it('fails to decrypt tampered ciphertext (GCM auth tag)', async () => {
    const dek = await generateDek()
    const encrypted = await encrypt('secret', dek)
    const [iv, ciphertext] = encrypted.split(':')

    // Flip a character in the ciphertext to corrupt the auth tag/data.
    const tamperedChar = ciphertext![0] === 'A' ? 'B' : 'A'
    const tampered = `${iv}:${tamperedChar}${ciphertext!.slice(1)}`

    await expect(decrypt(tampered, dek)).rejects.toThrow()
  })
})

describe('importKey / exportKey', () => {
  it('imports a base64 master key and uses it for encrypt/decrypt', async () => {
    const masterKeyBase64 = randomMasterKey()
    const key = await importKey(masterKeyBase64)

    const encrypted = await encrypt('payload', key)
    expect(await decrypt(encrypted, key)).toBe('payload')
  })

  it('exports a generated DEK to base64 and re-imports it identically', async () => {
    const dek = await generateDek()
    const dekBase64 = await exportKey(dek)

    // base64 of 32 bytes = 44 chars
    expect(dekBase64).toHaveLength(44)

    const reImported = await importKey(dekBase64)
    const encrypted = await encrypt('roundtrip', dek)
    expect(await decrypt(encrypted, reImported)).toBe('roundtrip')
  })
})

describe('envelope encryptSecret / decryptSecret', () => {
  it('round-trips a secret value through full envelope encryption', async () => {
    const masterKey = randomMasterKey()
    const value = 'postgres://user:pass@host:5432/db'

    const { encryptedValue, wrappedDek } = await encryptSecret(value, masterKey)
    const decrypted = await decryptSecret(encryptedValue, wrappedDek, masterKey)

    expect(decrypted).toBe(value)
  })

  it('never stores plaintext in the encrypted blob or wrapped DEK', async () => {
    const masterKey = randomMasterKey()
    const value = 'PLAINTEXT_MARKER_VALUE'

    const { encryptedValue, wrappedDek } = await encryptSecret(value, masterKey)

    expect(encryptedValue).not.toContain(value)
    expect(wrappedDek).not.toContain(value)
  })

  it('produces a sound wrapped-DEK structure (iv:ciphertext, unwraps to 44-char base64 key)', async () => {
    const masterKey = randomMasterKey()
    const { wrappedDek } = await encryptSecret('x', masterKey)

    const parts = wrappedDek.split(':')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveLength(16) // 12-byte IV

    // Unwrap the DEK directly with the master key and confirm it is a valid 256-bit key.
    const masterCryptoKey = await importKey(masterKey)
    const dekBase64 = await decrypt(wrappedDek, masterCryptoKey)
    expect(dekBase64).toHaveLength(44)
    // Re-import to prove it is a usable AES key.
    await expect(importKey(dekBase64)).resolves.toBeDefined()
  })

  it('generates a unique DEK per secret — two encryptions differ', async () => {
    const masterKey = randomMasterKey()
    const a = await encryptSecret('same-value', masterKey)
    const b = await encryptSecret('same-value', masterKey)

    expect(a.wrappedDek).not.toBe(b.wrappedDek)
    expect(a.encryptedValue).not.toBe(b.encryptedValue)
  })

  it('fails to decrypt with the wrong master key', async () => {
    const masterKey = randomMasterKey()
    const wrongMasterKey = randomMasterKey()
    const { encryptedValue, wrappedDek } = await encryptSecret('secret', masterKey)

    await expect(
      decryptSecret(encryptedValue, wrappedDek, wrongMasterKey),
    ).rejects.toThrow()
  })

  it('fails to decrypt when the wrapped DEK is tampered with', async () => {
    const masterKey = randomMasterKey()
    const { encryptedValue, wrappedDek } = await encryptSecret('secret', masterKey)

    const [iv, ct] = wrappedDek.split(':')
    const tamperedChar = ct![0] === 'A' ? 'B' : 'A'
    const tamperedDek = `${iv}:${tamperedChar}${ct!.slice(1)}`

    await expect(
      decryptSecret(encryptedValue, tamperedDek, masterKey),
    ).rejects.toThrow()
  })

  it('fails to decrypt when the encrypted value blob is tampered with', async () => {
    const masterKey = randomMasterKey()
    const { encryptedValue, wrappedDek } = await encryptSecret('secret', masterKey)

    const [iv, ct] = encryptedValue.split(':')
    const tamperedChar = ct![0] === 'A' ? 'B' : 'A'
    const tamperedValue = `${iv}:${tamperedChar}${ct!.slice(1)}`

    await expect(
      decryptSecret(tamperedValue, wrappedDek, masterKey),
    ).rejects.toThrow()
  })
})

describe('PBKDF2 key derivation', () => {
  it('generates a 16-byte salt (base64 = 24 chars)', () => {
    const salt = generateSalt()
    expect(salt).toHaveLength(24)
  })

  it('produces unique salts', () => {
    expect(generateSalt()).not.toBe(generateSalt())
  })

  it('is deterministic for the same password + salt', async () => {
    const salt = generateSalt()
    const a = await deriveKeyFromPassword('correct horse battery staple', salt)
    const b = await deriveKeyFromPassword('correct horse battery staple', salt)
    expect(a).toBe(b)
  })

  it('differs for a different password with the same salt', async () => {
    const salt = generateSalt()
    const a = await deriveKeyFromPassword('password-one', salt)
    const b = await deriveKeyFromPassword('password-two', salt)
    expect(a).not.toBe(b)
  })

  it('differs for the same password with a different salt', async () => {
    const a = await deriveKeyFromPassword('same-password', generateSalt())
    const b = await deriveKeyFromPassword('same-password', generateSalt())
    expect(a).not.toBe(b)
  })

  it('derives a usable 256-bit AES key (44-char base64) that round-trips', async () => {
    const derivedBase64 = await deriveKeyFromPassword('pw', generateSalt())
    expect(derivedBase64).toHaveLength(44)

    const key = await importKey(derivedBase64)
    expect(await decrypt(await encrypt('data', key), key)).toBe('data')
  })
})
