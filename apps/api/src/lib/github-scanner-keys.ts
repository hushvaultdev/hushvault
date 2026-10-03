// Public signing keys for GitHub's secret-scanning partner callback.
//
// Why this exists instead of a bare fetch in the route: the callback endpoint is
// unauthenticated by necessity (the signature IS the authentication), and the key
// lookup happened before anything was verified. One outbound request to
// api.github.com per inbound POST is an amplifier, and the GitHub REST API allows
// only 60 unauthenticated requests per hour per originating IP
// (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
// Once that budget is gone the lookup fails, the route rejects the callback, and a
// leaked API key is never revoked — a security control switched off by noise.
//
// So: cache the (public, tiny — two keys today) key set in KV, remember an id that
// was already looked up and missed, and bound refetches through the Durable Object
// limiter. Same structure as the JWKS cache in oidc-verify.ts, and the same reason
// for using the limiter rather than a KV read-modify-write: KV is not atomic, so a
// KV counter would let concurrent requests all fetch.
import type { Env } from '../index'
import { consumeIdentityLimit } from '../middleware/rate-limit'

export const KEYS_URL = 'https://api.github.com/meta/public_keys/secret_scanning'
export const KEYS_CACHE_TTL_SECONDS = 3600
export const REFETCH_WINDOW_SECONDS = 60
export const REFETCH_BUDGET_PER_CALLER = 3
export const REFETCH_BUDGET_GLOBAL = 60
export const FETCH_TIMEOUT_MS = 5000
export const MAX_KEYS_BYTES = 64 * 1024

const CACHE_KEY = 'ghss:public-keys'

export type GitHubPublicKey = {
  key_identifier: string
  key: string // PEM-encoded SPKI public key
  is_current?: boolean
}

type KeysResponse = { public_keys?: GitHubPublicKey[] }

/**
 * - `{ ok: true, pem }`      key found (from cache or a fresh fetch)
 * - `{ ok: false, code: 'UNKNOWN_KEY' }`  the key set does not contain this id
 * - `{ ok: false, code: 'UNAVAILABLE' }`  could not reach or parse the key set
 * - `{ ok: false, code: 'THROTTLED' }`    cannot look it up right now
 *
 * UNKNOWN_KEY is a bad caller; UNAVAILABLE and THROTTLED are our outage, and the
 * route must answer 5xx for those so GitHub retries instead of dropping the report.
 */
export type KeyLookup =
  | { ok: true; pem: string }
  | { ok: false; code: 'UNKNOWN_KEY' | 'UNAVAILABLE' | 'THROTTLED' }

async function readCache(env: Env): Promise<GitHubPublicKey[] | null> {
  try {
    const raw = await env.SECRETS_KV.get(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as KeysResponse
    return Array.isArray(parsed.public_keys) ? parsed.public_keys : null
  } catch {
    return null
  }
}

async function writeCache(env: Env, keys: GitHubPublicKey[]): Promise<void> {
  try {
    await env.SECRETS_KV.put(CACHE_KEY, JSON.stringify({ public_keys: keys }), { expirationTtl: KEYS_CACHE_TTL_SECONDS })
  } catch {
    // Caching is an optimisation; a verification still works without it.
  }
}

// Hashed, so a caller-supplied identifier can never shape a KV key.
async function missKey(keyId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyId))
  return `${CACHE_KEY}:miss:${[...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function recentlyMissed(env: Env, keyId: string): Promise<boolean> {
  try {
    return Boolean(await env.SECRETS_KV.get(await missKey(keyId)))
  } catch {
    return false
  }
}

async function rememberMiss(env: Env, keyId: string): Promise<void> {
  try {
    await env.SECRETS_KV.put(await missKey(keyId), '1', { expirationTtl: REFETCH_WINDOW_SECONDS })
  } catch {
    // best effort
  }
}

async function spendRefetch(env: Env, callerKey: string): Promise<boolean> {
  const windowMs = REFETCH_WINDOW_SECONDS * 1000
  const caller = await consumeIdentityLimit(env, {
    scope: 'ghss-refetch-caller', identity: callerKey, limit: REFETCH_BUDGET_PER_CALLER, windowMs,
  })
  if ('allowed' in caller && !caller.allowed) return false
  const global = await consumeIdentityLimit(env, {
    scope: 'ghss-refetch', identity: 'github', limit: REFETCH_BUDGET_GLOBAL, windowMs,
  })
  // An unavailable limiter must not stop a genuine key rotation being picked up.
  return !('allowed' in global) || global.allowed
}

async function fetchKeys(): Promise<GitHubPublicKey[] | null> {
  try {
    const res = await fetch(KEYS_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HushVault-SecretScanner' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    // Check the advertised size before materialising the body, then again after (the header can lie).
    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_KEYS_BYTES) return null
    const body = await res.text()
    if (body.length > MAX_KEYS_BYTES) return null
    const parsed = JSON.parse(body) as KeysResponse
    if (!Array.isArray(parsed.public_keys)) return null
    return parsed.public_keys.filter((k) => typeof k?.key_identifier === 'string' && typeof k?.key === 'string')
  } catch {
    // Network error, non-JSON body, or timeout.
    return null
  }
}

function find(keys: GitHubPublicKey[] | null, keyId: string): string | null {
  return keys?.find((k) => k.key_identifier === keyId)?.key ?? null
}

/** Resolve a signing key by its `GITHUB-PUBLIC-KEY-IDENTIFIER`, cached and rate-bounded. */
export async function getScannerPublicKey(env: Env, keyId: string, callerKey: string): Promise<KeyLookup> {
  const cached = await readCache(env)
  const hit = find(cached, keyId)
  if (hit) return { ok: true, pem: hit }

  // A key id already looked up and missed costs nothing to repeat.
  if (await recentlyMissed(env, keyId)) return { ok: false, code: 'UNKNOWN_KEY' }
  if (!(await spendRefetch(env, callerKey))) return { ok: false, code: 'THROTTLED' }

  const fresh = await fetchKeys()
  if (!fresh) return { ok: false, code: 'UNAVAILABLE' }
  await writeCache(env, fresh)

  const pem = find(fresh, keyId)
  if (pem) return { ok: true, pem }
  await rememberMiss(env, keyId)
  return { ok: false, code: 'UNKNOWN_KEY' }
}
