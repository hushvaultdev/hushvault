// RS256 / JWKS verification for third-party OIDC tokens (issue #43).
//
// Provider-agnostic: the caller supplies the issuer, the JWKS URL and the audience it requires. Nothing here
// trusts anything inside the token before the signature is checked, and every failure is an opaque code — a
// verification error must never tell a caller which part of its forgery was wrong.
//
// Caching: public JWKS are cached in KV (they are public data, not secrets) so a verification costs no outbound
// request in the common case. An unknown `kid` triggers at most one refetch, with a cooldown, so a flood of junk
// tokens cannot turn into a flood of outbound requests.
import type { Env } from '../index'

export const JWKS_CACHE_TTL_SECONDS = 3600
export const JWKS_REFETCH_COOLDOWN_SECONDS = 60
export const JWKS_FETCH_TIMEOUT_MS = 5000
export const MAX_JWKS_BYTES = 64 * 1024
/** Tokens are short-lived; allow a little clock drift in both directions. */
export const CLOCK_SKEW_SECONDS = 60

export type OidcFailure =
  | 'MALFORMED'            // not three base64url parts, or not JSON
  | 'UNSUPPORTED_ALG'      // anything but RS256, or no kid
  | 'UNKNOWN_KEY'          // kid not in the (freshly fetched) JWKS
  | 'BAD_SIGNATURE'
  | 'EXPIRED'              // exp in the past, or iat/nbf in the future
  | 'WRONG_ISSUER'
  | 'WRONG_AUDIENCE'
  | 'JWKS_UNAVAILABLE'     // could not fetch or parse the key set

export type OidcResult<C> = { ok: true; claims: C } | { ok: false; code: OidcFailure }

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; alg?: string; use?: string }
type Jwks = { keys?: Jwk[] }

const textDecoder = new TextDecoder()

function decodePart(part: string): unknown {
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return JSON.parse(textDecoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
}

function decodeSignature(part: string): Uint8Array {
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

function cacheKey(jwksUrl: string): string {
  return `jwks:${jwksUrl}`
}

async function fetchJwks(jwksUrl: string): Promise<Jwks | null> {
  // Only ever the configured https URL; nothing from the token influences it.
  if (!jwksUrl.startsWith('https://')) return null
  try {
    const res = await fetch(jwksUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = await res.text()
    if (body.length > MAX_JWKS_BYTES) return null
    const parsed = JSON.parse(body) as Jwks
    return Array.isArray(parsed.keys) ? parsed : null
  } catch {
    return null
  }
}

async function readCache(env: Env, jwksUrl: string): Promise<Jwks | null> {
  try {
    const raw = await env.SECRETS_KV.get(cacheKey(jwksUrl))
    return raw ? (JSON.parse(raw) as Jwks) : null
  } catch {
    return null
  }
}

async function writeCache(env: Env, jwksUrl: string, jwks: Jwks): Promise<void> {
  try {
    await env.SECRETS_KV.put(cacheKey(jwksUrl), JSON.stringify(jwks), { expirationTtl: JWKS_CACHE_TTL_SECONDS })
  } catch {
    // caching is an optimisation; verification still works without it
  }
}

/**
 * Refetch throttle. A fetch that resolves the key (cold cache, genuine rotation) costs nothing; only a fetch that
 * was WASTED — the key set did not contain the kid, or could not be fetched — starts a cooldown, so a flood of junk
 * `kid`s cannot turn into a flood of outbound requests while legitimate rotations are never delayed.
 */
async function refetchAllowed(env: Env, jwksUrl: string): Promise<boolean> {
  try {
    return !(await env.SECRETS_KV.get(`${cacheKey(jwksUrl)}:cooldown`))
  } catch {
    return true // without KV the request itself is still rate limited
  }
}

async function startCooldown(env: Env, jwksUrl: string): Promise<void> {
  try {
    await env.SECRETS_KV.put(`${cacheKey(jwksUrl)}:cooldown`, '1', { expirationTtl: JWKS_REFETCH_COOLDOWN_SECONDS })
  } catch {
    // throttling is best effort
  }
}

function findKey(jwks: Jwks | null, kid: string): Jwk | null {
  return jwks?.keys?.find((k) => k.kid === kid && (k.kty === 'RSA') && (k.alg === undefined || k.alg === 'RS256') && (k.use === undefined || k.use === 'sig')) ?? null
}

async function importRsa(jwk: Jwk): Promise<CryptoKey | null> {
  if (!jwk.n || !jwk.e) return null
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    return null
  }
}

export type OidcExpectation = {
  issuer: string
  jwksUrl: string
  /** The token's `aud` must equal this exactly (string form) or contain it (array form). */
  audience: string
}

/**
 * Verify an RS256 OIDC token and return its claims. The signature is checked BEFORE any claim is read for
 * authorisation; `iss`, `aud` and the time window are then checked here, and the caller matches the rest.
 */
export async function verifyOidcToken<C extends { iss?: string; aud?: string | string[]; exp?: number; iat?: number; nbf?: number }>(
  env: Env,
  token: string,
  expect: OidcExpectation,
  now: Date = new Date(),
): Promise<OidcResult<C>> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, code: 'MALFORMED' }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { alg?: string; kid?: string; typ?: string }
  let claims: C
  let signature: Uint8Array
  try {
    header = decodePart(headerPart) as { alg?: string; kid?: string; typ?: string }
    claims = decodePart(payloadPart) as C
    signature = decodeSignature(signaturePart)
  } catch {
    return { ok: false, code: 'MALFORMED' }
  }
  if (claims === null || typeof claims !== 'object') return { ok: false, code: 'MALFORMED' }
  // Only RS256, and only with a key id: "none" and symmetric algorithms are never acceptable here.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 256) {
    return { ok: false, code: 'UNSUPPORTED_ALG' }
  }

  let jwks = await readCache(env, expect.jwksUrl)
  let jwk = findKey(jwks, header.kid)
  if (!jwk) {
    // Unknown key: either the cache is cold or GitHub rotated. Refetch at most once per cooldown.
    if (!(await refetchAllowed(env, expect.jwksUrl))) return { ok: false, code: 'UNKNOWN_KEY' }
    jwks = await fetchJwks(expect.jwksUrl)
    if (!jwks) {
      await startCooldown(env, expect.jwksUrl)
      return { ok: false, code: 'JWKS_UNAVAILABLE' }
    }
    await writeCache(env, expect.jwksUrl, jwks)
    jwk = findKey(jwks, header.kid)
    if (!jwk) {
      await startCooldown(env, expect.jwksUrl)
      return { ok: false, code: 'UNKNOWN_KEY' }
    }
  }

  const key = await importRsa(jwk)
  if (!key) return { ok: false, code: 'UNKNOWN_KEY' }

  const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  let verified = false
  try {
    verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, code: 'BAD_SIGNATURE' }

  // Signature is good; now the standard claims.
  if (claims.iss !== expect.issuer) return { ok: false, code: 'WRONG_ISSUER' }
  const aud = claims.aud
  const audienceOk = typeof aud === 'string' ? aud === expect.audience : Array.isArray(aud) && aud.includes(expect.audience)
  if (!audienceOk) return { ok: false, code: 'WRONG_AUDIENCE' }

  const seconds = Math.floor(now.getTime() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds) return { ok: false, code: 'EXPIRED' }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > seconds) return { ok: false, code: 'EXPIRED' }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds) return { ok: false, code: 'EXPIRED' }

  return { ok: true, claims }
}
