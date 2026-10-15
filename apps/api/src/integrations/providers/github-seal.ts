// GitHub Actions secret sealing (issue #44). GitHub's secrets API requires each value encrypted as a libsodium
// `crypto_box_seal` (NaCl sealed box) against the repository's Curve25519 public key. WebCrypto cannot produce a
// sealed box (no XSalsa20-Poly1305, no sealed-box construction), so this file is the ONE, NARROW, owner-approved
// exception to the "WebCrypto only" rule (recorded on #37 / #44 / #107): a pair of vetted libraries used ONLY for
// the sealed-box construction, imported ONLY here. No cryptography is hand-rolled — every primitive comes from a
// vetted library. The plaintext value is never logged.
//
// Why not libsodium-wrappers (issue #107): libsodium-wrappers runs a secure-RNG probe at MODULE-IMPORT time and
// then instantiates WebAssembly from embedded bytes. The API Worker sets `no_nodejs_compat`, so the probe falls
// through to `require('crypto')` and throws `No secure random number generator found` (error 10021) at Worker
// startup — the deploy succeeds but the Worker fails to boot. Replaced with `tweetnacl` (pure-JS NaCl, same
// construction) + `@noble/hashes` BLAKE2b for the nonce. This is the same path erwinkn/coffre took after hitting
// the same wall on the same stack, and whs/tweetnacl-sealed-box documents the output is bit-compatible with
// libsodium `crypto_box_seal`. The existing test suite (`apps/api/test/github-seal.test.ts`) decrypts our output
// with libsodium's `crypto_box_seal_open`, so GitHub-interop is covered.
import nacl from 'tweetnacl'
import { blake2b } from '@noble/hashes/blake2.js'

const CURVE25519_KEY_BYTES = 32
const SEALED_BOX_NONCE_BYTES = 24

function decodeBase64(input: string): Uint8Array {
  // Workers' atob accepts standard base64 (what GitHub returns for the public key, and what we return).
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function encodeBase64(input: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < input.length; i++) binary += String.fromCharCode(input[i]!)
  return btoa(binary)
}

/**
 * Seal `value` for GitHub using the repository/environment public key (standard base64, as the public-key endpoint
 * returns it). Returns the base64 `encrypted_value` for the secrets PUT body. Throws if the key is not valid base64
 * or not a 32-byte Curve25519 key; the caller maps that to PROVIDER_VALIDATION. Never logs the value or the output.
 *
 * Sealed-box construction (NaCl `crypto_box_seal`, re-implemented over a vetted `crypto_box`):
 *   ephem = X25519 keypair (freshly random)
 *   nonce = BLAKE2b-24(ephem.publicKey || recipientPublic)
 *   box   = crypto_box(plaintext, nonce, recipientPublic, ephem.secretKey)
 *   out   = ephem.publicKey || box
 */
export async function sealForGitHub(base64PublicKey: string, value: string): Promise<string> {
  let recipientPublic: Uint8Array
  try {
    recipientPublic = decodeBase64(base64PublicKey)
  } catch {
    throw new Error('invalid public key encoding')
  }
  if (recipientPublic.length !== CURVE25519_KEY_BYTES) {
    throw new Error('invalid public key length')
  }

  const ephem = nacl.box.keyPair()
  const nonceInput = new Uint8Array(CURVE25519_KEY_BYTES * 2)
  nonceInput.set(ephem.publicKey, 0)
  nonceInput.set(recipientPublic, CURVE25519_KEY_BYTES)
  const nonce = blake2b(nonceInput, { dkLen: SEALED_BOX_NONCE_BYTES })

  const plaintext = new TextEncoder().encode(value)
  const box = nacl.box(plaintext, nonce, recipientPublic, ephem.secretKey)

  const sealed = new Uint8Array(ephem.publicKey.length + box.length)
  sealed.set(ephem.publicKey, 0)
  sealed.set(box, ephem.publicKey.length)
  return encodeBase64(sealed)
}
