import { describe, expect, it } from 'vitest'
import { encryptForShare } from '../../cli/src/commands/share'
import { decryptShare, toBase64Url } from '../../web/src/lib/share-crypto'

describe('web decryptShare', () => {
  it('decrypts a payload produced by the CLI encryptForShare (incl. unicode)', async () => {
    for (const secret of ['hunter2', 'pässwörd 🔑 with spaces\nand newline', 'x'.repeat(5000)]) {
      const { encryptedPayload, key } = await encryptForShare(secret)
      expect(await decryptShare(encryptedPayload, key)).toBe(secret)
    }
  })

  it('fails with the wrong key', async () => {
    const a = await encryptForShare('secret')
    const b = await encryptForShare('other')
    await expect(decryptShare(a.encryptedPayload, b.key)).rejects.toThrow()
  })

  it('fails on tampered payload, truncated payload, and malformed inputs', async () => {
    const { encryptedPayload, key } = await encryptForShare('secret')
    const bytes = Uint8Array.from(Buffer.from(encryptedPayload, 'base64url'))
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    await expect(decryptShare(toBase64Url(bytes), key)).rejects.toThrow()
    await expect(decryptShare(encryptedPayload.slice(0, 10), key)).rejects.toThrow()
    await expect(decryptShare('not base64url!!', key)).rejects.toThrow()
    await expect(decryptShare(encryptedPayload, 'AAAA')).rejects.toThrow()
  })
})
