/**
 * Envelope Encryption using WebCrypto (Cloudflare Workers native)
 *
 * Pattern: Master Key (KEK) → wraps Data Encryption Key (DEK) → encrypts secret value
 *
 * Storage format: base64(iv):base64(ciphertext):base64(authTag)
 */

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96-bit IV for GCM

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
export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded)

  return `${bufferToBase64(iv)}:${bufferToBase64(ciphertext)}`
}

/**
 * Decrypt ciphertext with a CryptoKey
 * Expects: "base64(iv):base64(ciphertext+authTag)"
 */
export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  const [ivB64, ciphertextB64] = encrypted.split(':')
  if (!ivB64 || !ciphertextB64) throw new Error('Invalid encrypted format')

  const iv = base64ToBuffer(ivB64)
  const ciphertext = base64ToBuffer(ciphertextB64)

  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/**
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
}

export type KeyRing = {
  readonly activeVersion: string
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
export function loadKeyRing(env: KeyRingEnv): KeyRing {
  const activeVersion = env.ENCRYPTION_ACTIVE_KEY_VERSION?.trim() || 'v1'
  if (!isValidKeyVersion(activeVersion)) throw new KeyRingError('KEY_VERSION_INVALID')
  const cache = new Map<string, Promise<CryptoKey>>()
  const ring: KeyRing = {
    activeVersion,
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

/** Envelope-encrypt under the ring's active key. Returns the version used. */
export async function encryptSecretWithRing(value: string, ring: KeyRing): Promise<{
  encryptedValue: string
  wrappedDek: string
  keyVersion: string
}> {
  const kek = await ring.getKey(ring.activeVersion)
  const dek = await generateDek()
  const encryptedValue = await encrypt(value, dek)
  const wrappedDek = await encrypt(await exportKey(dek), kek)
  return { encryptedValue, wrappedDek, keyVersion: ring.activeVersion }
}

/** Envelope-decrypt using the key version recorded on the row. */
export async function decryptSecretWithRing(
  encryptedValue: string,
  wrappedDek: string,
  keyVersion: string,
  ring: KeyRing,
): Promise<string> {
  const kek = await ring.getKey(keyVersion)
  const dekBuffer = base64ToBuffer(await decrypt(wrappedDek, kek))
  if (dekBuffer.byteLength !== KEK_BYTES) throw new Error('Invalid DEK')
  const dek = await crypto.subtle.importKey('raw', dekBuffer, { name: ALGORITHM, length: KEY_LENGTH }, false, ['decrypt'])
  return decrypt(encryptedValue, dek)
}

/**
 * Re-wrap a DEK from one key version to another with a fresh IV. The DEK itself
 * (and therefore the KV ciphertext) is unchanged. The new wrap is verified by
 * unwrapping it with the target key before it is returned.
 */
export async function rewrapDek(wrappedDek: string, fromKey: CryptoKey, toKey: CryptoKey): Promise<string> {
  const dekBase64 = await decrypt(wrappedDek, fromKey)
  if (base64ToBuffer(dekBase64).byteLength !== KEK_BYTES) throw new Error('Invalid DEK')
  const rewrapped = await encrypt(dekBase64, toKey)
  if ((await decrypt(rewrapped, toKey)) !== dekBase64) throw new Error('Re-wrap verification failed')
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

/**
 * Derive a key from a password using PBKDF2 (WebCrypto-native)
 */
export async function deriveKeyFromPassword(password: string, saltBase64: string): Promise<string> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])

  const salt = base64ToBuffer(saltBase64)
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    baseKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  )

  return exportKey(derived)
}

/**
 * Generate a random salt (for PBKDF2)
 */
export function generateSalt(): string {
  return bufferToBase64(crypto.getRandomValues(new Uint8Array(16)))
}

// Helpers
function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
