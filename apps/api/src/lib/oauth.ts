import { createBase64Url, decodeBase64Url, timingSafeEqual } from './auth'

// GitHub OAuth helpers. Stateless, CSRF-safe `state` tokens (HMAC-signed with
// JWT_SECRET, short TTL) avoid needing server-side session storage, and thin
// wrappers around the GitHub REST API exchange the code for an identity.

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

export interface GitHubIdentity {
  id: string
  login: string
  name: string | null
  email: string | null
}

export async function fetchGitHubIdentity(accessToken: string): Promise<GitHubIdentity | null> {
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
