import keytar from 'keytar'
import { getGlobalConfig, saveGlobalConfig } from './project'

const KEYCHAIN_SERVICE = 'hushvault'

/**
 * Store auth token securely in OS keychain
 * macOS → Keychain, Windows → Credential Manager, Linux → libsecret
 */
export async function storeToken(email: string, token: string): Promise<void> {
  await keytar.setPassword(KEYCHAIN_SERVICE, email, token)
  await saveGlobalConfig({ currentUser: email })
}

/**
 * Retrieve auth token from OS keychain
 */
export async function getToken(): Promise<string | null> {
  const config = await getGlobalConfig()
  const email = config['currentUser']
  if (!email) return null
  return keytar.getPassword(KEYCHAIN_SERVICE, email)
}

/**
 * Get token for CI/CD — prefers HUSHVAULT_TOKEN env var
 */
export async function getAuthToken(): Promise<string> {
  // CI/CD: use environment variable
  const envToken = process.env['HUSHVAULT_TOKEN']
  if (envToken) return envToken

  // Local dev: use OS keychain
  const token = await getToken()
  if (!token) {
    throw new Error('Not logged in. Run: hushvault login')
  }
  return token
}

/**
 * Clear stored credentials (logout)
 */
export async function clearToken(): Promise<void> {
  const config = await getGlobalConfig()
  const email = config['currentUser']
  if (email) await keytar.deletePassword(KEYCHAIN_SERVICE, email)
  await saveGlobalConfig({})
}
