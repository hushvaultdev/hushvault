import { getGlobalConfig, saveGlobalConfig } from './project.js'

const KEYCHAIN_SERVICE = 'hushvault'

export class KeychainUnavailableError extends Error {
  constructor() {
    super(
      'OS keychain is not available (is libsecret installed?). Tokens are never written to plaintext files. ' +
        'Set the HUSHVAULT_TOKEN environment variable (API key or JWT) instead.',
    )
    this.name = 'KeychainUnavailableError'
  }
}

interface Keytar {
  setPassword(service: string, account: string, password: string): Promise<void>
  getPassword(service: string, account: string): Promise<string | null>
  deletePassword(service: string, account: string): Promise<boolean>
}

/** Load keytar lazily so the CLI still starts without the native module. */
async function loadKeytar(): Promise<Keytar> {
  try {
    const mod = (await import('keytar')) as unknown as { default?: Keytar } & Partial<Keytar>
    const k = (mod.default ?? mod) as Keytar
    if (typeof k.setPassword !== 'function') throw new Error('keytar missing')
    return k
  } catch {
    throw new KeychainUnavailableError()
  }
}

/**
 * Store auth token in the OS keychain.
 * Throws KeychainUnavailableError if keytar cannot be loaded or the keychain errors.
 */
export async function storeToken(email: string, token: string): Promise<void> {
  const keytar = await loadKeytar()
  try {
    await keytar.setPassword(KEYCHAIN_SERVICE, email, token)
  } catch {
    throw new KeychainUnavailableError()
  }
  const existing = await getGlobalConfig()
  await saveGlobalConfig({ ...existing, currentUser: email })
}

const refreshAccount = (email: string) => `${email}#refresh`

/** Store the rotating refresh token next to the access token (same keychain, separate entry). */
export async function storeRefreshToken(email: string, refreshToken: string): Promise<void> {
  const keytar = await loadKeytar()
  try {
    await keytar.setPassword(KEYCHAIN_SERVICE, refreshAccount(email), refreshToken)
  } catch {
    throw new KeychainUnavailableError()
  }
}

export async function getRefreshToken(): Promise<{ email: string; refreshToken: string } | null> {
  const email = (await getGlobalConfig())['currentUser']
  if (!email) return null
  try {
    const value = await (await loadKeytar()).getPassword(KEYCHAIN_SERVICE, refreshAccount(email))
    return value ? { email, refreshToken: value } : null
  } catch {
    return null
  }
}

/** Retrieve auth token from OS keychain (null if none / keychain unavailable). */
export async function getToken(): Promise<string | null> {
  const config = await getGlobalConfig()
  const email = config['currentUser']
  if (!email) return null
  try {
    const keytar = await loadKeytar()
    return await keytar.getPassword(KEYCHAIN_SERVICE, email)
  } catch {
    return null
  }
}

/** HUSHVAULT_TOKEN (API key or JWT) takes precedence; otherwise the OS keychain. */
export async function getAuthToken(): Promise<string> {
  const envToken = process.env['HUSHVAULT_TOKEN']
  if (envToken) return envToken

  const token = await getToken()
  if (!token) {
    throw new Error('Not logged in. Run: hushvault login (or set HUSHVAULT_TOKEN)')
  }
  return token
}

/** Clear stored credentials (logout) */
export async function clearToken(): Promise<void> {
  const config = await getGlobalConfig()
  const email = config['currentUser']
  if (email) {
    try {
      const keytar = await loadKeytar()
      await keytar.deletePassword(KEYCHAIN_SERVICE, email)
      await keytar.deletePassword(KEYCHAIN_SERVICE, refreshAccount(email))
    } catch {
      // nothing to clear if the keychain is unavailable
    }
  }
  await saveGlobalConfig({})
}
