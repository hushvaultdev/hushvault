import { ApiClient, type EnvironmentRow } from '../api.js'
import { getAuthToken } from '../config/auth.js'
import { findProjectConfig, getGlobalConfig, DEFAULT_API_URL, type HushVaultConfig } from '../config/project.js'

export interface ProjectContext {
  config: HushVaultConfig
  client: ApiClient
}

export async function resolveApiUrl(explicit?: string, projectApiUrl?: string): Promise<string> {
  if (explicit) return explicit
  if (projectApiUrl) return projectApiUrl
  const fromEnv = process.env['HUSHVAULT_API_URL']
  if (fromEnv) return fromEnv
  const global = await getGlobalConfig()
  return global['apiUrl'] ?? DEFAULT_API_URL
}

/** Load .hushvault.json (walking up from cwd) and an authenticated client. */
export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContext> {
  const found = await findProjectConfig(cwd)
  if (!found) throw new Error('No .hushvault.json found. Run: hushvault init')
  const token = await getAuthToken()
  const apiUrl = await resolveApiUrl(undefined, found.config.apiUrl)
  return { config: found.config, client: new ApiClient({ apiUrl, token }) }
}

/** Resolve an env id, slug or name (case-insensitive) to an environment row. */
export async function resolveEnvironment(client: ApiClient, projectId: string, input: string): Promise<EnvironmentRow> {
  const envs = await client.listEnvironments(projectId)
  const lower = input.toLowerCase()
  const found =
    envs.find((e) => e.id === input) ??
    envs.find((e) => e.slug.toLowerCase() === lower) ??
    envs.find((e) => e.name.toLowerCase() === lower)
  if (!found) {
    const slugs = envs.map((e) => e.slug).join(', ') || '(none)'
    throw new Error(`Environment "${input}" not found. Valid environments: ${slugs}`)
  }
  return found
}

export function pickEnvInput(option: string | undefined, config: HushVaultConfig): string {
  const env = option ?? config.defaultEnv
  if (!env) throw new Error('No environment specified. Use --env or set defaultEnv in .hushvault.json')
  return env
}

/** Read all of stdin as UTF-8 (used when a value is supplied via pipe). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks).toString('utf8')
}

/** Strip exactly one trailing newline (as added by `echo`). */
export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '')
}

/** Authenticated client that does not need a project (org-level commands such as `sync`). */
export async function loadClient(cwd = process.cwd()): Promise<ApiClient> {
  const found = await findProjectConfig(cwd)
  const token = await getAuthToken()
  const apiUrl = await resolveApiUrl(undefined, found?.config.apiUrl)
  return new ApiClient({ apiUrl, token })
}
