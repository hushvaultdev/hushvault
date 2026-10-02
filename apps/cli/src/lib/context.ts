import { ApiClient, type EnvironmentRow } from '../api.js'
import { getAuthToken } from '../config/auth.js'
import { findProjectConfig, getGlobalConfig, DEFAULT_API_URL, type HushVaultConfig } from '../config/project.js'

export interface ProjectContext {
  config: HushVaultConfig
  client: ApiClient
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Where credentials are sent: --api-url, then HUSHVAULT_API_URL, then the URL recorded at login,
 * then the default. A committed .hushvault.json can NOT choose this: otherwise a malicious repo
 * could point the CLI at its own server and collect the bearer token. The project's apiUrl is only
 * checked against it, and a mismatch is refused before any request is made.
 */
export async function resolveApiUrl(explicit?: string, projectApiUrl?: string): Promise<string> {
  const trusted = explicit ?? process.env['HUSHVAULT_API_URL'] ?? (await getGlobalConfig())['apiUrl'] ?? DEFAULT_API_URL
  if (projectApiUrl && originOf(projectApiUrl) !== originOf(trusted)) {
    throw new Error(
      `This project's .hushvault.json points at ${projectApiUrl}, but you are signed in to ${trusted}. ` +
        'Credentials are never sent to a server chosen by a repository file. ' +
        `If you trust it, run: hushvault login --api-url ${projectApiUrl} (or set HUSHVAULT_API_URL).`,
    )
  }
  return trusted
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
