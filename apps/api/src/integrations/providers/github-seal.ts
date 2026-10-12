// GitHub Actions secret sealing (issue #44). GitHub's secrets API requires each value encrypted as a libsodium
// `crypto_box_seal` (NaCl sealed box) against the repository's Curve25519 public key. WebCrypto cannot produce a
// sealed box (no XSalsa20-Poly1305, no sealed-box construction), so this is the ONE, NARROW, owner-approved
// exception to the "WebCrypto only" rule (recorded on #37 / #44): a vetted library (libsodium-wrappers), pinned,
// used ONLY for crypto_box_seal, imported ONLY here. No cryptography is hand-rolled — this calls the vetted
// primitive, which honours "never implement custom cryptography". The plaintext value is never logged.
import sodium from 'libsodium-wrappers'

let readyPromise: Promise<void> | null = null

/** libsodium loads its WASM asynchronously; await this once before any call. */
async function ensureReady(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready
  await readyPromise
}

/**
 * Seal `value` for GitHub using the repository/environment public key (standard base64, as the public-key endpoint
 * returns it). Returns the base64 `encrypted_value` for the secrets PUT body. Throws if the key is not valid base64
 * or not a 32-byte Curve25519 key; the caller maps that to PROVIDER_VALIDATION. Never logs the value or the output.
 */
export async function sealForGitHub(base64PublicKey: string, value: string): Promise<string> {
  await ensureReady()
  const publicKey = sodium.from_base64(base64PublicKey, sodium.base64_variants.ORIGINAL)
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error('invalid public key length')
  }
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey)
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL)
}
