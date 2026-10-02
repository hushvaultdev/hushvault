// GitHub Actions OIDC: the GitHub-specific layer over lib/oidc-verify (issue #43).
//
// Authorisation matches INDIVIDUAL claims, never the `sub` string: a repository can customise the template that
// builds `sub`, but it cannot change `repository`, `repository_id`, `ref` or `environment`. Matching `sub` with a
// prefix would also be unsafe ("repo:acme/app:ref:refs/heads/main" is a prefix of nothing useful, but
// "repo:acme/app-evil:..." starts with "repo:acme/app"), so every comparison here is an exact string equality.
import type { Env } from '../index'

/**
 * Defaults for github.com-hosted Actions. Both are overridable so a GitHub Enterprise Server deployment (which has
 * its own issuer) can be configured without a code change. UNVERIFIED against live endpoints from this environment
 * (egress is blocked); confirm both before the first production use — see docs/integrations/github-oidc.md.
 */
export const DEFAULT_GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
export const DEFAULT_GITHUB_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks'

/** Claims this code reads. GitHub sends many more; anything not listed here is ignored. */
export type GitHubOidcClaims = {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  iat?: number
  nbf?: number
  /** "owner/name". Mutable: a transfer moves it, which is why repository_id can be pinned. */
  repository?: string
  /** Immutable numeric id of the repository. */
  repository_id?: string
  repository_owner?: string
  repository_owner_id?: string
  /** "refs/heads/main" etc. Absent for an environment-scoped token. */
  ref?: string
  /** GitHub environment name. Present only when the job declares `environment:`. */
  environment?: string
  event_name?: string
  workflow_ref?: string
  job_workflow_ref?: string
  run_id?: string
  actor?: string
}

export type OidcRule = {
  id: string
  orgId: string
  envId: string
  repository: string
  repositoryId: string | null
  ref: string | null
  environment: string | null
}

/**
 * Does this rule authorise these claims? Exact equality on every field, with the repository compared lowercased
 * (GitHub preserves the owner's casing; the rule is stored lowercased). A rule constrains either a ref or a GitHub
 * environment, and the matching claim must be present: a token with neither matches nothing.
 */
export function ruleMatches(rule: OidcRule, claims: GitHubOidcClaims): boolean {
  if (typeof claims.repository !== 'string' || claims.repository.toLowerCase() !== rule.repository) return false
  if (rule.repositoryId !== null && claims.repository_id !== rule.repositoryId) return false
  if (rule.ref !== null) return typeof claims.ref === 'string' && claims.ref === rule.ref
  if (rule.environment !== null) return typeof claims.environment === 'string' && claims.environment === rule.environment
  return false
}

export function githubOidcConfig(env: Env): { issuer: string; jwksUrl: string; audience: string } {
  return {
    issuer: env.GITHUB_OIDC_ISSUER?.trim() || DEFAULT_GITHUB_ISSUER,
    jwksUrl: env.GITHUB_OIDC_JWKS_URL?.trim() || DEFAULT_GITHUB_JWKS_URL,
    // A HushVault-specific audience is a security control: a token minted for another service cannot be replayed
    // here, and vice versa. Defaults to this deployment's own API origin.
    audience: env.GITHUB_OIDC_AUDIENCE?.trim() || env.API_PUBLIC_URL?.trim() || 'https://api.hushvault.dev',
  }
}
