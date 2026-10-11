// Targets HushVault must never push to. Shared by the routes (fail early with a 422) and the sync engine
// (enforced again at plan and run time, because the env vars can change after a target was created and the
// scheduler never passes through a route).
import type { Env } from '../index'

/** Scripts that may never be a sync target, whatever the env var says (HushVault's own Workers). */
export const DEFAULT_DENIED_SCRIPTS: readonly string[] = ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev', 'hushvault-web-local']

type DenyEnv = Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS' | 'HUSHVAULT_SYNC_DENY_ACCOUNT_IDS' | 'ENVIRONMENT'>
type AccountDenyEnv = Pick<Env, 'HUSHVAULT_SYNC_DENY_ACCOUNT_IDS' | 'ENVIRONMENT'>

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

/** Default list plus the comma separated HUSHVAULT_SYNC_DENY_SCRIPTS var, lower-cased. The var can only add. */
export function deniedScripts(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS'> | undefined): Set<string> {
  return new Set([...DEFAULT_DENIED_SCRIPTS, ...list(env?.HUSHVAULT_SYNC_DENY_SCRIPTS)])
}

export function isDeniedScript(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS'> | undefined, scriptName: string): boolean {
  return deniedScripts(env).has(scriptName.toLowerCase())
}

/** Cloudflare account ids (comma list in HUSHVAULT_SYNC_DENY_ACCOUNT_IDS) that targets and connections may not use. */
export function deniedAccountIds(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'> | undefined): Set<string> {
  return new Set(list(env?.HUSHVAULT_SYNC_DENY_ACCOUNT_IDS))
}

/**
 * FAIL CLOSED in production (issue #41, 2026-10-11 security review): without account ids the
 * denylist is name-only, so any secret on a HushVault-account Worker outside DEFAULT_DENIED_SCRIPTS
 * would be overwritable by a target. An empty HUSHVAULT_SYNC_DENY_ACCOUNT_IDS in production is
 * therefore treated as "deny every account" — misconfiguration stops sync writes instead of
 * silently weakening the control. The var is committed in wrangler.toml for every deployed env.
 */
export function accountDenylistMisconfigured(env: AccountDenyEnv | undefined): boolean {
  return env?.ENVIRONMENT === 'production' && deniedAccountIds(env).size === 0
}

export function isDeniedAccount(env: AccountDenyEnv | undefined, accountId: unknown): boolean {
  if (accountDenylistMisconfigured(env)) return true
  return typeof accountId === 'string' && deniedAccountIds(env).has(accountId.toLowerCase())
}

/** True when the target's resource or its connection's config points at a denied script or account. */
export function isTargetDenied(env: DenyEnv | undefined, resource: Record<string, unknown>, connectionConfig?: Record<string, unknown>): boolean {
  if (accountDenylistMisconfigured(env)) return true
  const script = resource['scriptName']
  if (typeof script === 'string' && isDeniedScript(env, script)) return true
  if (isDeniedAccount(env, resource['accountId'])) return true
  return connectionConfig !== undefined && isDeniedAccount(env, connectionConfig['accountId'])
}
