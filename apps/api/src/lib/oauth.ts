import { createBase64Url, decodeBase64Url, timingSafeEqual } from './auth'

// OAuth helpers (GitHub + Google). Stateless, CSRF-safe `state` tokens
// (HMAC-signed with JWT_SECRET, short TTL) avoid needing server-side session
// storage, and thin wrappers around each provider's REST API exchange the
// authorization code for a normalised identity.

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const STATE_TTL_MS = 10 * 60 * 1000

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(data))
  return createBase64Url(signature)
}

export async function signState(secret: string): Promise<string> {
  const payload = {
    nonce: createBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    exp: Date.now() + STATE_TTL_MS,
  }
  const body = createBase64Url(textEncoder.encode(JSON.stringify(payload)))
  return `${body}.${await hmacSign(secret, body)}`
}

export async function verifyState(secret: string, state: string): Promise<boolean> {
  const parts = state.split('.')
  if (parts.length !== 2) return false
  const [body, signature] = parts as [string, string]
  const expected = await hmacSign(secret, body)
  if (!timingSafeEqual(signature, expected)) return false
  try {
    const payload = JSON.parse(textDecoder.decode(decodeBase64Url(body))) as { exp?: number }
    return typeof payload.exp === 'number' && payload.exp > Date.now()
  } catch {
    return false
  }
}

export async function exchangeGitHubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { access_token?: string }
  return data.access_token ?? null
}

// Provider-agnostic identity. `login` is a username-ish handle used for the
// workspace slug and a display-name fallback (derived from the email local
// part for providers that don't expose a username, like Google).
export interface OAuthIdentity {
  id: string
  login: string
  name: string | null
  email: string | null
}

export async function fetchGitHubIdentity(accessToken: string): Promise<OAuthIdentity | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'HushVault',
    Accept: 'application/vnd.github+json',
  }

  const userRes = await fetch('https://api.github.com/user', { headers })
  if (!userRes.ok) return null
  const user = (await userRes.json()) as { id: number; login: string; name: string | null; email: string | null }

  let email = user.email
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', { headers })
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
      const chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
      email = chosen?.email ?? null
    }
  }

  return { id: String(user.id), login: user.login, name: user.name, email }
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { access_token?: string }
  return data.access_token ?? null
}

export async function fetchGoogleIdentity(accessToken: string): Promise<OAuthIdentity | null> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as {
    sub: string
    email?: string
    email_verified?: boolean | string
    name?: string | null
  }

  // Only trust verified Google emails (the flag may arrive as a string).
  const verified = user.email_verified === true || user.email_verified === 'true'
  const email = verified ? (user.email ?? null) : null
  const login = email ? (email.split('@')[0] ?? 'user') : 'user'

  return { id: user.sub, login, name: user.name ?? null, email }
}
