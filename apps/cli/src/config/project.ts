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
 * Walk up parent directories to find .hushvault.json (like git)
 */
export async function findProjectConfig(startDir = process.cwd()): Promise<{ config: HushVaultConfig; configDir: string } | null> {
  let currentDir = startDir

  while (true) {
    const configPath = path.join(currentDir, CONFIG_FILE)
    try {
      const raw = await fs.readFile(configPath, 'utf8')
      return { config: JSON.parse(raw) as HushVaultConfig, configDir: currentDir }
    } catch {
      const parent = path.dirname(currentDir)
      if (parent === currentDir) return null // reached filesystem root
      currentDir = parent
    }
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

export const DEFAULT_API_URL = 'https://api.hushvault.com'
