import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface HushVaultConfig {
  projectId: string
  projectName?: string
  defaultEnv: string
  apiUrl: string
  createdAt?: string
}

const CONFIG_FILE = '.hushvault.json'
// Resolved lazily so HOME / HUSHVAULT_CONFIG_DIR changes take effect (and tests can redirect it)
function globalConfigDir(): string {
  return process.env['HUSHVAULT_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'hushvault')
}
function globalConfigFile(): string {
  return path.join(globalConfigDir(), 'config.json')
}

/**
 * Validate a parsed .hushvault.json.
 *
 * This file comes from a repository, which may not be yours — `JSON.parse(raw) as HushVaultConfig`
 * was a lie that surfaced as a confusing error much later: a file containing `null` produced
 * "Cannot read properties of null", and `{"projectId": 123}` produced "Not logged in". Check the
 * shape here and say which file is wrong.
 */
export function parseProjectConfig(raw: string, configPath: string): HushVaultConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${configPath} is not valid JSON.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object.`)
  }
  const o = parsed as Record<string, unknown>
  const str = (key: string, required: boolean): string | undefined => {
    const v = o[key]
    if (v === undefined || v === null) {
      if (required) throw new Error(`${configPath} is missing "${key}".`)
      return undefined
    }
    if (typeof v !== 'string') throw new Error(`${configPath}: "${key}" must be a string.`)
    return v
  }
  const projectId = str('projectId', true) as string
  const defaultEnv = str('defaultEnv', true) as string
  const config: HushVaultConfig = { projectId, defaultEnv, apiUrl: str('apiUrl', false) ?? DEFAULT_API_URL }
  const projectName = str('projectName', false)
  if (projectName !== undefined) config.projectName = projectName
  const createdAt = str('createdAt', false)
  if (createdAt !== undefined) config.createdAt = createdAt
  return config
}

/**
 * Walk up parent directories to find .hushvault.json (like git)
 */
export async function findProjectConfig(startDir = process.cwd()): Promise<{ config: HushVaultConfig; configDir: string } | null> {
  let currentDir = startDir

  while (true) {
    const configPath = path.join(currentDir, CONFIG_FILE)
    let raw: string
    try {
      raw = await fs.readFile(configPath, 'utf8')
    } catch {
      const parent = path.dirname(currentDir)
      if (parent === currentDir) return null // reached filesystem root
      currentDir = parent
      continue
    }
    // Parse failures are reported, not swallowed: walking past a malformed config and silently
    // picking up an ancestor's is worse than saying which file is broken.
    return { config: parseProjectConfig(raw, configPath), configDir: currentDir }
  }
}

/**
 * Write .hushvault.json to current directory
 */
export async function writeProjectConfig(config: HushVaultConfig, dir = process.cwd()): Promise<void> {
  await fs.writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

/**
 * Get global config (API URL, current user)
 */
export async function getGlobalConfig(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(globalConfigFile(), 'utf8')
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Save global config
 */
export async function saveGlobalConfig(config: Record<string, string>): Promise<void> {
  await fs.mkdir(globalConfigDir(), { recursive: true })
  await fs.writeFile(globalConfigFile(), JSON.stringify(config, null, 2), 'utf8')
}

export const DEFAULT_API_URL = 'https://api.hushvault.dev'
