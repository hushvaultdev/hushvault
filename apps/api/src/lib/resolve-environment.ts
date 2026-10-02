// Environment resolution shared by GET /api/environments/:id/resolved and the sync engine (issue #40):
// branch inheritance (child overrides parent by name, depth-limited), per-org scoping, AAD-bound
// decryption and computed-secret evaluation. Returns data or a coded failure; never logs values.
import { decryptSecretWithRing, loadKeyRing } from '../crypto/envelope'
import type { Env } from '../index'
import { describeComputedError, evaluateSecrets, type ComputedError } from './resolve'
import { logKeyRingError } from './security'

export const MAX_INHERITANCE_DEPTH = 10

type SecretRow = { id: string; env_id: string; name: string; is_computed: number; template: string | null; wrapped_dek: string; key_version: string; enc_version: number }

export type ResolvedSecret = {
  id: string
  name: string
  isComputed: boolean
  template: string | null
  /** Environment id the value comes from, or null when it belongs to the requested environment. */
  inheritedFrom: string | null
  /** Present only when values were requested. */
  value?: string
}

export type ResolveFailure =
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'INVALID_ENVIRONMENT_CHAIN'; message: string }
  | { ok: false; code: 'DECRYPTION_FAILED' }
  | { ok: false; code: 'COMPUTED_ERROR'; error: ComputedError; message: string }

export type ResolveResult =
  | { ok: true; environmentId: string; projectId: string; secrets: ResolvedSecret[] }
  | ResolveFailure

/** Resolve an environment inside one organisation. `values: false` returns names and metadata only. */
export async function resolveEnvironment(env: Env, orgId: string, environmentId: string, opts: { values: boolean }): Promise<ResolveResult> {
  const environment = await env.DB.prepare(
    'SELECT e.id, e.project_id, e.parent_env_id FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE e.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(environmentId, orgId).first<{ id: string; project_id: string; parent_env_id: string | null }>()

  if (!environment) return { ok: false, code: 'NOT_FOUND' }

  // Chain ordered root ... self. Every ancestor must be in the same project (hence same org).
  const chain: string[] = [environment.id]
  const seen = new Set<string>(chain)
  let parentId = environment.parent_env_id
  while (parentId) {
    if (seen.has(parentId) || chain.length > MAX_INHERITANCE_DEPTH) {
      return { ok: false, code: 'INVALID_ENVIRONMENT_CHAIN', message: 'Environment inheritance chain is circular or too deep' }
    }
    const parent = await env.DB.prepare('SELECT id, parent_env_id FROM environments WHERE id = ? AND project_id = ? LIMIT 1')
      .bind(parentId, environment.project_id).first<{ id: string; parent_env_id: string | null }>()
    if (!parent) {
      return { ok: false, code: 'INVALID_ENVIRONMENT_CHAIN', message: 'Parent environment is invalid' }
    }
    seen.add(parent.id)
    chain.unshift(parent.id)
    parentId = parent.parent_env_id
  }

  const rank = new Map(chain.map((envId, index) => [envId, index]))
  const rows = await env.DB.prepare(
    `SELECT id, env_id, name, is_computed, template, wrapped_dek, key_version, enc_version FROM secrets WHERE project_id = ? AND env_id IN (${chain.map(() => '?').join(',')})`,
  ).bind(environment.project_id, ...chain).all<SecretRow>()

  // Later (closer to the requested env) rank wins.
  const merged = new Map<string, SecretRow>()
  for (const row of [...(rows.results ?? [])].sort((a, b) => (rank.get(a.env_id) ?? 0) - (rank.get(b.env_id) ?? 0))) {
    merged.set(row.name, row)
  }
  const selected = [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const plain = new Map<string, string>()
  if (opts.values) {
    try {
      const ring = loadKeyRing(env)
      for (const row of selected) {
        if (row.is_computed) continue
        const blob = await env.SECRETS_KV.get(`secret:${row.id}`)
        if (blob === null) throw new Error('missing blob')
        plain.set(row.name, await decryptSecretWithRing(
          blob, row.wrapped_dek, row.key_version, ring,
          { projectId: environment.project_id, envId: row.env_id, secretId: row.id }, row.enc_version,
        ))
      }
    } catch (err) {
      logKeyRingError(err)
      return { ok: false, code: 'DECRYPTION_FAILED' }
    }
  }

  let evaluated: Map<string, string> | null = null
  if (opts.values) {
    const result = evaluateSecrets(selected.map((row) => ({
      name: row.name,
      isComputed: Boolean(row.is_computed),
      template: row.template,
      ...(row.is_computed ? {} : { value: plain.get(row.name) ?? '' }),
    })))
    if (!result.ok) {
      return { ok: false, code: 'COMPUTED_ERROR', error: result.error, message: describeComputedError(result.error) }
    }
    evaluated = result.values
  }

  return {
    ok: true,
    environmentId: environment.id,
    projectId: environment.project_id,
    secrets: selected.map((row) => ({
      id: row.id,
      name: row.name,
      isComputed: Boolean(row.is_computed),
      template: row.template,
      inheritedFrom: row.env_id === environment.id ? null : row.env_id,
      ...(evaluated ? { value: evaluated.get(row.name) ?? '' } : {}),
    })),
  }
}
