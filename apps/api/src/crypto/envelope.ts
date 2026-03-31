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
  return crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_LENGTH }, true, ['encrypt', 'decrypt'])
}

/**
 * Export a CryptoKey to base64 string
 */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
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
