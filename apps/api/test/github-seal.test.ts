import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers'
import { sealForGitHub } from '../src/integrations/providers/github-seal'

beforeAll(async () => { await sodium.ready })

describe('sealForGitHub (NaCl sealed box for GitHub secrets)', () => {
  it('produces an encrypted_value that the matching secret key decrypts back to the plaintext', async () => {
    const { publicKey, privateKey } = sodium.crypto_box_keypair()
    const base64PublicKey = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
    const value = 'super-secret-value-CANARY-7f3a'

    const encrypted = await sealForGitHub(base64PublicKey, value)
    // It is standard base64 and is not the plaintext.
    expect(encrypted).not.toContain(value)
    expect(/^[A-Za-z0-9+/]+=*$/.test(encrypted)).toBe(true)

    // The recipient (holding the secret key) can open the sealed box -> the API will store a value GitHub can decrypt.
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey,
    )
    expect(sodium.to_string(opened)).toBe(value)
  })

  it('is non-deterministic (a fresh ephemeral key per seal)', async () => {
    const { publicKey } = sodium.crypto_box_keypair()
    const base64PublicKey = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
    const a = await sealForGitHub(base64PublicKey, 'same-value')
    const b = await sealForGitHub(base64PublicKey, 'same-value')
    expect(a).not.toBe(b)
  })

  it('rejects a key that is not a 32-byte Curve25519 key', async () => {
    await expect(sealForGitHub(sodium.to_base64(new Uint8Array(16), sodium.base64_variants.ORIGINAL), 'x')).rejects.toThrow()
  })
})
