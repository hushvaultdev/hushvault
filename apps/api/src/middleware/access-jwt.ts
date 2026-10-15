// Cloudflare Access gate on /api/admin/* (issue #108 finding 1). Deliberately its own file, not
// folded into auth.ts or platform-admin.ts: this verifies a different token (Access's RS256 JWT,
// not the app's own session JWT) against a different trust root (Access's JWKS), and is the outer
// gate that must run before any DB work. requireAccessBinding (its own file) ties the verified
// Access identity to the signed-in app session; this file only verifies the token itself.
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { verifyOidcToken } from '../lib/oidc-verify'

/** Sentinel for the local-dev bypass: distinguishes "no Access check ran" from "Access verification failed",
 * so requireAccessBinding can tell the two apart and must not reject a legitimately bypassed request. */
export const ACCESS_BYPASSED = Symbol('access-bypassed')

declare module 'hono' {
  interface ContextVariableMap {
    /** Lower-cased `email` claim from a verified Cloudflare Access JWT, or ACCESS_BYPASSED in local dev. */
    accessEmail: string | typeof ACCESS_BYPASSED
  }
}

type AccessClaims = { iss?: string; aud?: string | string[]; exp?: number; iat?: number; nbf?: number; email?: string }

function accessJwksUrl(teamDomain: string): string {
  return `${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/**
 * Must run before requireAuth on /api/admin/*. Fails closed in production when Access is
 * unconfigured — a missing CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD must never silently downgrade
 * to "no Access gate", since that is exactly the gap finding 1 describes. The only bypass is for
 * local development, gated on ENVIRONMENT (server-controlled), never on a client-supplied Host
 * header, which an attacker fully controls.
 */
export const requireAccessJwt: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const isProduction = c.env.ENVIRONMENT === 'production'
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN
  const audience = c.env.CF_ACCESS_AUD

  if (!isProduction) {
    let hostname = ''
    try {
      hostname = new URL(c.req.url).hostname
    } catch {
      hostname = ''
    }
    if (isLocalHostname(hostname)) {
      c.set('accessEmail', ACCESS_BYPASSED)
      return next()
    }
  }

  if (!teamDomain || !audience) {
    if (isProduction) {
      return c.json({ error: 'ACCESS_NOT_CONFIGURED', message: 'Service temporarily unavailable. Please try again shortly.' }, 503)
    }
    // Non-production, non-localhost (e.g. the dev Worker's public hostname) with Access unset:
    // still fail closed rather than silently skip verification, since this path is reachable
    // from outside the local machine.
    return c.json({ error: 'ACCESS_NOT_CONFIGURED', message: 'Service temporarily unavailable. Please try again shortly.' }, 503)
  }

  const token = c.req.header('cf-access-jwt-assertion')
  if (!token) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Access verification required' }, 401)
  }

  const result = await verifyOidcToken<AccessClaims>(c.env, token, {
    issuer: teamDomain,
    jwksUrl: accessJwksUrl(teamDomain),
    audience,
    // cf-connecting-ip is set by Cloudflare at the edge and cannot be forged by the client,
    // unlike x-forwarded-for (see .claude/rules — audit-log.md's sibling guidance for IPs).
    callerKey: c.req.header('cf-connecting-ip') ?? undefined,
  })
  if (!result.ok || typeof result.claims.email !== 'string' || result.claims.email.length === 0) {
    // Opaque regardless of which check failed (malformed, bad signature, wrong aud, expired, ...);
    // oidc-verify.ts's own design goal is that a forger never learns which part of its forgery
    // broke verification.
    return c.json({ error: 'UNAUTHORIZED', message: 'Access verification required' }, 401)
  }

  c.set('accessEmail', result.claims.email.toLowerCase())
  return next()
}
