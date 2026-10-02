// Targets HushVault must never push to. Shared by the routes (fail early with a 422) and the sync engine
// (enforced again at plan and run time, because the env vars can change after a target was created and the
// scheduler never passes through a route).
import type { Env } from '../index'

/** Scripts that may never be a sync target, whatever the env var says (HushVault's own Workers). */
export const DEFAULT_DENIED_SCRIPTS: readonly string[] = ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev', 'hushvault-web-local']

type DenyEnv = Pick<Env, 'HUSHVAULT_SYNC_DENY_SCRIPTS' | 'HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'>

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

export function isDeniedAccount(env: Pick<Env, 'HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'> | undefined, accountId: unknown): boolean {
  return typeof accountId === 'string' && deniedAccountIds(env).has(accountId.toLowerCase())
}

/** True when the target's resource or its connection's config points at a denied script or account. */
export function isTargetDenied(env: DenyEnv | undefined, resource: Record<string, unknown>, connectionConfig?: Record<string, unknown>): boolean {
  const script = resource['scriptName']
  if (typeof script === 'string' && isDeniedScript(env, script)) return true
  if (isDeniedAccount(env, resource['accountId'])) return true
  return connectionConfig !== undefined && isDeniedAccount(env, connectionConfig['accountId'])
}
