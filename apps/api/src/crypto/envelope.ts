/**
 * Envelope Encryption using WebCrypto (Cloudflare Workers native)
 *
 * Pattern: Master Key (KEK) → wraps Data Encryption Key (DEK) → encrypts secret value
 *
 * Storage format (two parts, not three — AES-GCM appends the 16-byte auth tag to the ciphertext):
 *   legacy: base64(iv):base64(ciphertext+tag)
 *   v2:     v2:base64(iv):base64(ciphertext+tag)     value blobs, AAD-bound to their record
 *   c2:     c2:base64(iv):base64(ciphertext+tag)     integration credentials
 * See docs/ENCRYPTION.md for the AAD definitions.
 */

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96-bit IV for GCM
const FORMAT_V2 = 'v2' // blob prefix: AES-GCM with additional authenticated data (record context)
const FORMAT_CRED = 'c2' // blob prefix for integration credentials (a different AAD domain from secrets)
const TAGS = new Set([FORMAT_V2, FORMAT_CRED])

/** Identifies the record a ciphertext belongs to; bound into the GCM tag so blobs cannot be moved. */
export type SecretContext = { projectId: string; envId: string; secretId: string }

function contextPart(value: string): string {
  if (value.length === 0 || value.includes('|')) throw new Error('Invalid context')
  return value
}

/** AAD for the secret value (DEK-encrypted blob in KV). Same bytes for a row's history blobs. */
export function valueAad(ctx: SecretContext): Uint8Array {
  return new TextEncoder().encode(`hushvault|value|v2|${contextPart(ctx.projectId)}|${contextPart(ctx.envId)}|${contextPart(ctx.secretId)}`)
}

/** AAD for the wrapped DEK. Excludes the key version so rotation can re-wrap without changing it. */
export function wrapAad(secretId: string): Uint8Array {
  return new TextEncoder().encode(`hushvault|wrap|v2|${contextPart(secretId)}`)
}

/**
 * Import a raw 256-bit key from base64 string
 */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(base64Key)
  return crypto.subtle.importKey('raw', raw, { name: ALGORITHM, length: KEY_LENGTH }, false, ['encrypt', 'decrypt'])
}

/**
 * Generate a new random 256-bit AES-GCM key (used as DEK)
 */
export async function generateDek(): Promise<CryptoKey> {
  return (await crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_LENGTH }, true, ['encrypt', 'decrypt'])) as CryptoKey
}

/**
 * Export a CryptoKey to base64 string
 */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = (await crypto.subtle.exportKey('raw', key)) as ArrayBuffer
  return bufferToBase64(raw)
}

/**
 * Encrypt plaintext with a CryptoKey
 * Returns: "base64(iv):base64(ciphertext+authTag)"
 */
export async function encrypt(plaintext: string, key: CryptoKey, aad?: Uint8Array, tag: string = FORMAT_V2): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoded = new TextEncoder().encode(plaintext)

  const params: { name: string; iv: Uint8Array; additionalData?: Uint8Array } = aad ? { name: ALGORITHM, iv, additionalData: aad } : { name: ALGORITHM, iv }
  const ciphertext = await crypto.subtle.encrypt(params, key, encoded)

  const body = `${bufferToBase64(iv)}:${bufferToBase64(ciphertext)}`
  return aad ? `${tag}:${body}` : body
}

/**
 * Decrypt ciphertext with a CryptoKey
 * Expects: "base64(iv):base64(ciphertext+authTag)"
 */
export async function decrypt(encrypted: string, key: CryptoKey, aad?: Uint8Array): Promise<string> {
  const parts = encrypted.split(':')
  // Format and AAD must agree: a v2 blob is never decrypted without its context and a legacy
  // blob is never accepted where a context is required (no silent downgrade).
  const isV2 = TAGS.has(parts[0] ?? '')
  if (isV2 !== Boolean(aad)) throw new Error('Invalid encrypted format')
  const [ivB64, ciphertextB64] = isV2 ? parts.slice(1) : parts
  if (!ivB64 || !ciphertextB64 || parts.length !== (isV2 ? 3 : 2)) throw new Error('Invalid encrypted format')

  const iv = base64ToBuffer(ivB64)
  const ciphertext = base64ToBuffer(ciphertextB64)

  const params: { name: string; iv: Uint8Array; additionalData?: Uint8Array } = aad ? { name: ALGORITHM, iv, additionalData: aad } : { name: ALGORITHM, iv }
  const plaintext = await crypto.subtle.decrypt(params, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/**
 * LEGACY (v1, no AAD). Kept only to read/produce pre-AAD rows in tests and migrations.
 * Encrypt a secret value using envelope encryption:
 * 1. Generate a new DEK
 * 2. Encrypt the secret value with the DEK
 * 3. Wrap the DEK with the master KEK
 */
export async function encryptSecret(value: string, masterKeyBase64: string): Promise<{
  encryptedValue: string
  wrappedDek: string
}> {
  const masterKey = await importKey(masterKeyBase64)
  const dek = await generateDek()

  const encryptedValue = await encrypt(value, dek)
  const dekBase64 = await exportKey(dek)
  const wrappedDek = await encrypt(dekBase64, masterKey)

  return { encryptedValue, wrappedDek }
}

/**
 * Decrypt a secret value using envelope encryption:
 * 1. Unwrap the DEK using the master KEK
 * 2. Decrypt the secret value with the DEK
 */
export async function decryptSecret(encryptedValue: string, wrappedDek: string, masterKeyBase64: string): Promise<string> {
  const masterKey = await importKey(masterKeyBase64)
  const dekBase64 = await decrypt(wrappedDek, masterKey)

  const dekBuffer = base64ToBuffer(dekBase64)
  const dek = await crypto.subtle.importKey('raw', dekBuffer, { name: ALGORITHM, length: KEY_LENGTH }, false, ['decrypt'])

  return decrypt(encryptedValue, dek)
}

// ---------------------------------------------------------------------------
// Key ring (KEK versions)
//
// Version `v1` is the legacy ENCRYPTION_MASTER_KEY secret. Version `vN` (N >= 2)
// is the Worker secret ENCRYPTION_KEY_V<N>. New writes use the active version
// (ENCRYPTION_ACTIVE_KEY_VERSION, default `v1`); reads use the key named by the
// row's key_version. See docs/ENCRYPTION.md ("Key rotation").
// ---------------------------------------------------------------------------

const KEY_VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/
const KEK_BYTES = 32
const KEY_CHECK_PLAINTEXT = 'hushvault-key-check-v1' // fixed, non-secret canary

/** Raised for configuration problems. Messages never include key material. */
export class KeyRingError extends Error {
  constructor(readonly code: 'KEY_VERSION_UNAVAILABLE' | 'KEY_INVALID' | 'KEY_VERSION_INVALID', readonly version?: string) {
    super(code)
    this.name = 'KeyRingError'
  }
}

export type KeyRingEnv = {
  ENCRYPTION_MASTER_KEY: string
  ENCRYPTION_ACTIVE_KEY_VERSION?: string | undefined
  // 'true' refuses legacy (no-AAD) ciphertext entirely. Turn on once every row is enc_version 2.
  ENFORCE_AAD?: string | undefined
}

export type KeyRing = {
  readonly activeVersion: string
  readonly allowLegacy: boolean
  has(version: string): boolean
  getKey(version: string): Promise<CryptoKey>
}

export function isValidKeyVersion(version: string): boolean {
  return KEY_VERSION_PATTERN.test(version)
}

function keySecretName(version: string): string {
  return version === 'v1' ? 'ENCRYPTION_MASTER_KEY' : `ENCRYPTION_KEY_V${version.slice(1)}`
}

function readKeyMaterial(env: KeyRingEnv, version: string): string | undefined {
  if (!isValidKeyVersion(version)) throw new KeyRingError('KEY_VERSION_INVALID')
  const value = (env as unknown as Record<string, unknown>)[keySecretName(version)]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function importKek(base64Key: string, usages: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
  let raw: Uint8Array
  try {
    raw = base64ToBuffer(base64Key)
  } catch {
    throw new KeyRingError('KEY_INVALID')
  }
  if (raw.byteLength !== KEK_BYTES) throw new KeyRingError('KEY_INVALID')
  return crypto.subtle.importKey('raw', raw, { name: ALGORITHM, length: KEY_LENGTH }, false, usages)
}

/**
 * Build the key ring from the Worker environment. Keys are imported lazily and
 * memoised per ring instance (one per request or scheduled tick), never globally.
 */
export function loadKeyRing(env: KeyRingEnv, override?: { activeVersion?: string }): KeyRing {
  const activeVersion = override?.activeVersion ?? (env.ENCRYPTION_ACTIVE_KEY_VERSION?.trim() || 'v1')
  if (!isValidKeyVersion(activeVersion)) throw new KeyRingError('KEY_VERSION_INVALID')
  const cache = new Map<string, Promise<CryptoKey>>()
  const ring: KeyRing = {
    activeVersion,
    allowLegacy: env.ENFORCE_AAD?.trim() !== 'true',
    has: (version) => isValidKeyVersion(version) && readKeyMaterial(env, version) !== undefined,
    getKey(version) {
      const hit = cache.get(version)
      if (hit) return hit
      const material = readKeyMaterial(env, version)
      if (material === undefined) return Promise.reject(new KeyRingError('KEY_VERSION_UNAVAILABLE', version))
      const pending = importKek(material, ['encrypt', 'decrypt'])
      cache.set(version, pending)
      return pending
    },
  }
  return ring
}

/** True if `wrappedDek` unwraps under `key` to a 32-byte DEK. Used to sanity-check a key against real data. */
export async function canUnwrapDek(wrappedDek: string, key: CryptoKey, secretId: string): Promise<boolean> {
  try {
    return base64ToBuffer(await decrypt(wrappedDek, key, wrapAadFor(wrappedDek, secretId))).byteLength === KEK_BYTES
  } catch {
    return false
  }
}

/** AAD for a wrapped DEK, chosen by its stored format (legacy blobs have none). */
function wrapAadFor(wrappedDek: string, recordId: string): Uint8Array | undefined {
  if (wrappedDek.startsWith(`${FORMAT_V2}:`)) return wrapAad(recordId)
  if (wrappedDek.startsWith(`${FORMAT_CRED}:`)) return credentialWrapAad(recordId)
  return undefined
}

// ---------------------------------------------------------------------------
// Integration credentials (issue #39). Same envelope and key ring as secrets (so key rotation re-wraps
// them), but a different blob tag and AAD domain: a secret blob can never be substituted for a
// credential blob, nor one connection's credential for another's or another organisation's.
// ---------------------------------------------------------------------------

export type CredentialContext = { orgId: string; connectionId: string }

export function credentialAad(ctx: CredentialContext): Uint8Array {
  return new TextEncoder().encode(`hushvault|credential|v2|${contextPart(ctx.orgId)}|${contextPart(ctx.connectionId)}`)
}

export function credentialWrapAad(connectionId: string): Uint8Array {
  return new TextEncoder().encode(`hushvault|credential-wrap|v2|${contextPart(connectionId)}`)
}

export async function encryptCredentialWithRing(value: string, ring: KeyRing, ctx: CredentialContext): Promise<{
  encryptedCredential: string
  wrappedDek: string
  keyVersion: string
}> {
  const kek = await ring.getKey(ring.activeVersion)
  const dek = await generateDek()
  const encryptedCredential = await encrypt(value, dek, credentialAad(ctx), FORMAT_CRED)
  const wrappedDek = await encrypt(await exportKey(dek), kek, credentialWrapAad(ctx.connectionId), FORMAT_CRED)
  return { encryptedCredential, wrappedDek, keyVersion: ring.activeVersion }
}

export async function decryptCredentialWithRing(
  encryptedCredential: string,
  wrappedDek: string,
  keyVersion: string,
  ring: KeyRing,
  ctx: CredentialContext,
): Promise<string> {
  if (!encryptedCredential.startsWith(`${FORMAT_CRED}:`) || !wrappedDek.startsWith(`${FORMAT_CRED}:`)) throw new Error('Invalid encrypted format')
  const kek = await ring.getKey(keyVersion)
  const dekBuffer = base64ToBuffer(await decrypt(wrappedDek, kek, credentialWrapAad(ctx.connectionId)))
  if (dekBuffer.byteLength !== KEK_BYTES) throw new Error('Invalid DEK')
  const dek = await crypto.subtle.importKey('raw', dekBuffer, { name: ALGORITHM, length: KEY_LENGTH }, false, ['decrypt'])
  return decrypt(encryptedCredential, dek, credentialAad(ctx))
}

/** Envelope-encrypt under the ring's active key, bound to the record context. Always writes v2. */
export async function encryptSecretWithRing(value: string, ring: KeyRing, ctx: SecretContext): Promise<{
  encryptedValue: string
  wrappedDek: string
  keyVersion: string
  encVersion: 2
}> {
  const kek = await ring.getKey(ring.activeVersion)
  const dek = await generateDek()
  const encryptedValue = await encrypt(value, dek, valueAad(ctx))
  const wrappedDek = await encrypt(await exportKey(dek), kek, wrapAad(ctx.secretId))
  return { encryptedValue, wrappedDek, keyVersion: ring.activeVersion, encVersion: 2 }
}

/** Envelope-decrypt using the key version recorded on the row. */
export async function decryptSecretWithRing(
  encryptedValue: string,
  wrappedDek: string,
  keyVersion: string,
  ring: KeyRing,
  ctx: SecretContext,
  encVersion: number,
): Promise<string> {
  // The D1 enc_version column decides the format; a blob that disagrees is rejected, not downgraded.
  if (encVersion !== 2 && !(encVersion === 1 && ring.allowLegacy)) throw new Error('Unsupported encryption version')
  const v2 = encVersion === 2
  const kek = await ring.getKey(keyVersion)
  const dekBuffer = base64ToBuffer(await decrypt(wrappedDek, kek, v2 ? wrapAad(ctx.secretId) : undefined))
  if (dekBuffer.byteLength !== KEK_BYTES) throw new Error('Invalid DEK')
  const dek = await crypto.subtle.importKey('raw', dekBuffer, { name: ALGORITHM, length: KEY_LENGTH }, false, ['decrypt'])
  return decrypt(encryptedValue, dek, v2 ? valueAad(ctx) : undefined)
}

/**
 * Re-wrap a DEK from one key version to another with a fresh IV. The DEK itself
 * (and therefore the KV ciphertext) is unchanged. The new wrap is verified by
 * unwrapping it with the target key before it is returned.
 */
export async function rewrapDek(wrappedDek: string, fromKey: CryptoKey, toKey: CryptoKey, secretId: string): Promise<string> {
  const aad = wrapAadFor(wrappedDek, secretId)
  const dekBase64 = await decrypt(wrappedDek, fromKey, aad)
  if (base64ToBuffer(dekBase64).byteLength !== KEK_BYTES) throw new Error('Invalid DEK')
  // Keep the blob's format tag (secret vs credential) so its AAD domain does not change.
  const rewrapped = await encrypt(dekBase64, toKey, aad, wrappedDek.startsWith(`${FORMAT_CRED}:`) ? FORMAT_CRED : FORMAT_V2)
  if ((await decrypt(rewrapped, toKey, aad)) !== dekBase64) throw new Error('Re-wrap verification failed')
  return rewrapped
}

/** Key-check value: an encryption of a fixed non-secret string. No key material is stored. */
export async function makeKeyCheck(key: CryptoKey): Promise<string> {
  return encrypt(KEY_CHECK_PLAINTEXT, key)
}

export async function verifyKeyCheck(key: CryptoKey, checkValue: string): Promise<boolean> {
  try {
    return (await decrypt(checkValue, key)) === KEY_CHECK_PLAINTEXT
  } catch {
    return false
  }
}

// Helpers
function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // Chunked: spreading a large array into String.fromCharCode overflows the call stack.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
