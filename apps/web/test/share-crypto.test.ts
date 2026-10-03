import { describe, expect, it } from 'vitest'

import { decryptShare, fromBase64Url, toBase64Url } from '../src/lib/share-crypto'

// The only end-to-end crypto that runs in the browser, and it had no test at all. These mirror
// how `hv share` produces a payload: random 32-byte key, random 12-byte IV, AES-256-GCM, with
// the IV prepended to the ciphertext and the key carried only in the URL fragment.
async function encryptLikeCli(plaintext: string): Promise<{ payload: string; key: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt'])
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const payload = new Uint8Array(iv.length + ct.length)
  payload.set(iv, 0)
  payload.set(ct, iv.length)
  return { payload: toBase64Url(payload), key: toBase64Url(rawKey) }
}

describe('decryptShare', () => {
  it('round-trips short, long and multi-byte values', async () => {
    for (const value of ['x', 'postgres://user:pw@host:5432/db', '🔐 ünïcode ✓', 'a'.repeat(5000)]) {
      const { payload, key } = await encryptLikeCli(value)
      expect(await decryptShare(payload, key)).toBe(value)
    }
  })

  it('fails closed on every malformed input rather than returning garbage', async () => {
    const { payload, key } = await encryptLikeCli('secret')

    await expect(decryptShare(payload, key.slice(0, -4))).rejects.toThrow()        // truncated key
    await expect(decryptShare(payload, `${key} `)).rejects.toThrow()               // trailing space
    await expect(decryptShare(payload, toBase64Url(crypto.getRandomValues(new Uint8Array(32))))).rejects.toThrow() // wrong key
    await expect(decryptShare(payload.slice(0, 20), key)).rejects.toThrow()        // truncated payload
    await expect(decryptShare('', key)).rejects.toThrow()                          // empty payload
    await expect(decryptShare(payload, '')).rejects.toThrow()                      // empty key
  })

  it('rejects a tampered ciphertext (the GCM tag is checked)', async () => {
    const { payload, key } = await encryptLikeCli('secret')
    const bytes = fromBase64Url(payload)
    const last = bytes.length - 1
    bytes[last] = (bytes[last] ?? 0) ^ 0xff
    await expect(decryptShare(toBase64Url(bytes), key)).rejects.toThrow()
  })
})
