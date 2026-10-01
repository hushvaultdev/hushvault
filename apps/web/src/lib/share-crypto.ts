// Decrypts payloads produced by `hv share` (apps/cli/src/commands/share.ts).
// payload = base64url(iv[12] || ciphertext+tag); key = base64url(raw 32 bytes).
// WebCrypto only. Pure and Node/browser runnable; never logs or persists values.

const IV_LENGTH = 12
const KEY_LENGTH = 32

export function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(input)) throw new Error('Invalid base64url')
  const b64 = input.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function decryptShare(payloadB64Url: string, keyB64Url: string): Promise<string> {
  const subtle = globalThis.crypto.subtle
  const payload = fromBase64Url(payloadB64Url)
  const rawKey = fromBase64Url(keyB64Url)
  if (rawKey.length !== KEY_LENGTH || payload.length <= IV_LENGTH + 16) {
    throw new Error('Invalid share data')
  }
  const key = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt'])
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: payload.slice(0, IV_LENGTH) },
    key,
    payload.slice(IV_LENGTH),
  )
  return new TextDecoder().decode(plain)
}
