import { Hono } from 'hono'
import type { Env } from '../index'
import { hashApiKey } from '../lib/auth'
import { notifyKeyRevoked } from '../lib/notify'
import { getRequestIp, writeAuditLog } from '../lib/security'

export const secretScannerRouter = new Hono<{ Bindings: Env }>()

// GitHub Secret Scanning partner callback.
// Docs: https://docs.github.com/en/developers/overview/secret-scanning-partner-program
//
// GitHub POSTs a JSON array of detected token matches and signs the raw request
// body with an ECDSA P-256 key. We verify the signature against GitHub's
// published public keys, then revoke any matching hv_live_* API key.

const GITHUB_KEYS_URL = 'https://api.github.com/meta/public_keys/secret_scanning'
const KEY_ID_HEADER = 'GITHUB-PUBLIC-KEY-IDENTIFIER'
const SIGNATURE_HEADER = 'GITHUB-PUBLIC-KEY-SIGNATURE'
// Bound work per request: GitHub batches are small; reject implausibly large
// payloads so a single callback can't tie up the worker with hashes + queries.
const MAX_MATCHES = 1000
// Cap the upstream key fetch so a hung GitHub response can't stall the callback.
const KEY_FETCH_TIMEOUT_MS = 5000

type GitHubSecretMatch = {
  token: string
  type: string
  url?: string
  source?: string
}

type GitHubPublicKey = {
  key_identifier: string
  key: string // PEM-encoded SPKI public key
  is_current: boolean
}

type GitHubPublicKeysResponse = {
  public_keys: GitHubPublicKey[]
}

// GitHub's per-match resolution response shape.
type TokenResolution = {
  token_raw: string
  token_type: string
  label: 'true_positive' | 'false_positive'
}

const textEncoder = new TextEncoder()

// Decode a base64 (standard, not url) string to bytes.
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

// Convert a PEM block to its DER bytes (SPKI).
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return base64ToBytes(body)
}

// ECDSA signatures from GitHub are ASN.1 DER encoded, but WebCrypto's verify
// expects the raw fixed-width r||s concatenation. This parses the DER SEQUENCE
// of two INTEGERs and left-pads each to 32 bytes (P-256). Pure parsing — no
// cryptography is implemented here.
function derEcdsaToRaw(der: Uint8Array): Uint8Array | null {
  let offset = 0
  if (der[offset++] !== 0x30) return null // SEQUENCE
  // Sequence length (assume short form / single length byte; sufficient for P-256).
  if (der[offset] !== undefined && der[offset]! & 0x80) {
    const lenBytes = der[offset]! & 0x7f
    offset += 1 + lenBytes
  } else {
    offset += 1
  }

  const readInt = (): Uint8Array | null => {
    if (der[offset++] !== 0x02) return null // INTEGER
    const len = der[offset++]
    if (len === undefined) return null
    let value = der.subarray(offset, offset + len)
    offset += len
    // Strip a leading 0x00 sign byte, then left-pad to 32 bytes.
    while (value.length > 0 && value[0] === 0x00) value = value.subarray(1)
    if (value.length > 32) return null
    const padded = new Uint8Array(32)
    padded.set(value, 32 - value.length)
    return padded
  }

  const r = readInt()
  const s = readInt()
  if (!r || !s) return null
  const raw = new Uint8Array(64)
  raw.set(r, 0)
  raw.set(s, 32)
  return raw
}

async function fetchGitHubPublicKey(keyId: string): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_KEYS_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'HushVault-SecretScanner',
      },
      signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as GitHubPublicKeysResponse
    const match = body.public_keys?.find((k) => k.key_identifier === keyId)
    return match?.key ?? null
  } catch {
    // Network error, non-JSON body, or timeout — treat as unavailable.
    return null
  }
}

// Verify GitHub's ECDSA P-256 / SHA-256 signature over the raw request body.
async function verifyGitHubSignature(keyPem: string, signatureB64: string, rawBody: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      pemToDer(keyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const rawSignature = derEcdsaToRaw(base64ToBytes(signatureB64))
    if (!rawSignature) return false
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      rawSignature,
      textEncoder.encode(rawBody),
    )
  } catch {
    return false
  }
}

// POST /api/integrations/secret-scanner/github
secretScannerRouter.post('/github', async (c) => {
  const keyId = c.req.header(KEY_ID_HEADER)
  const signature = c.req.header(SIGNATURE_HEADER)
  if (!keyId || !signature) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Missing signature headers' }, 401)
  }

  // Read the raw body exactly as signed (do not parse before verifying).
  const rawBody = await c.req.text()

  const keyPem = await fetchGitHubPublicKey(keyId)
  if (!keyPem) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Unknown signing key' }, 401)
  }

  const isValid = await verifyGitHubSignature(keyPem, signature, rawBody)
  if (!isValid) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid signature' }, 401)
  }

  let matches: GitHubSecretMatch[]
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (!Array.isArray(parsed)) throw new Error('expected array')
    matches = parsed as GitHubSecretMatch[]
  } catch {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Body must be a JSON array of matches' }, 400)
  }

  if (matches.length > MAX_MATCHES) {
    return c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Too many matches in a single request' }, 413)
  }

  const db = c.env.DB
  const now = new Date().toISOString()
  const ip = getRequestIp(c)
  const userAgent = c.req.header('user-agent')
  const results: TokenResolution[] = []

  for (const match of matches) {
    if (typeof match?.token !== 'string' || typeof match?.type !== 'string') {
      continue
    }

    // Hash the leaked token and look it up; we never store/log the raw token.
    const keyHash = await hashApiKey(match.token)
    const apiKey = await db
      .prepare('SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = ? LIMIT 1')
      .bind(keyHash)
      .first<{ id: string; user_id: string; revoked_at: string | null }>()

    if (!apiKey) {
      // Not one of ours (or already rotated out) — report as a false positive.
      results.push({ token_raw: match.token, token_type: match.type, label: 'false_positive' })
      continue
    }

    // Already revoked by an earlier callback or a retry — it's still our key
    // (true positive) but skip the re-stamp + duplicate audit/notify events.
    if (apiKey.revoked_at) {
      results.push({ token_raw: match.token, token_type: match.type, label: 'true_positive' })
      continue
    }

    // Resolve the owning org via the user's membership for audit + notification.
    const member = await db
      .prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
      .bind(apiKey.user_id)
      .first<{ org_id: string }>()

    // Revoke using the existing expiry mechanism (auth middleware rejects expired
    // keys), and stamp the soft-revocation audit columns. The `revoked_at IS NULL`
    // guard keeps this a no-op if a concurrent callback already revoked the key.
    await db
      .prepare('UPDATE api_keys SET expires_at = ?, revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(now, now, 'leaked_in_github', apiKey.id)
      .run()

    if (member) {
      await writeAuditLog(c.env, {
        orgId: member.org_id,
        actorId: null,
        actorType: 'system',
        action: 'auth.api_key.revoke',
        resourceType: 'api_key',
        resourceId: apiKey.id,
        ip,
        userAgent,
      })

      await notifyKeyRevoked(c.env, {
        orgId: member.org_id,
        apiKeyId: apiKey.id,
        reason: 'leaked_in_github',
        source: typeof match.url === 'string' ? match.url : null,
      })
    }

    results.push({ token_raw: match.token, token_type: match.type, label: 'true_positive' })
  }

  return c.json(results)
})
