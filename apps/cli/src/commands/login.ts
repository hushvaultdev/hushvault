import { Command } from 'commander'
import chalk from 'chalk'
import { ApiClient, ApiError, friendlyError } from '../api.js'
import { storeToken, storeRefreshToken, KeychainUnavailableError } from '../config/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config/project.js'
import { resolveApiUrl } from '../lib/context.js'
import { prompt } from '../lib/prompt.js'

export interface LoginOptions {
  apiUrl?: string | undefined
  email?: string | undefined
  /** Injected for tests; defaults to interactive prompts (password is not echoed). */
  ask?: (question: string, hidden: boolean) => Promise<string>
}

export async function loginAction(options: LoginOptions = {}): Promise<{ email: string; userId: string }> {
  const apiUrl = await resolveApiUrl(options.apiUrl)
  const ask = options.ask ?? ((q, hidden) => prompt(q, hidden))

  const email = (options.email ?? (await ask('Email: ', false))).trim()
  const password = await ask('Password: ', true)
  if (!email || !password) throw new Error('Email and password are required')

  let result
  try {
    result = await new ApiClient({ apiUrl }).login(email, password)
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : friendlyError(err, 'Login')
    throw new Error(`Login failed: ${msg}`)
  }

  // Throws KeychainUnavailableError (with guidance) if the keychain can't be used.
  await storeToken(email, result.token)
  if (result.refreshToken) await storeRefreshToken(email, result.refreshToken)
  const existing = await getGlobalConfig()
  await saveGlobalConfig({ ...existing, currentUser: email, apiUrl })
  return { email, userId: result.userId }
}

export const loginCommand = new Command('login')
  .description('Authenticate with HushVault')
  .option('--api-url <url>', 'API URL (default: https://api.hushvault.dev)')
  .option('--email <email>', 'Email (prompted if omitted)')
  .action(async (options: { apiUrl?: string; email?: string }) => {
    try {
      console.log(chalk.bold('\nHushVault Login\n'))
      const { email } = await loginAction(options)
      console.log(chalk.green(`\n✓ Logged in as ${email}`))
      console.log(chalk.gray('  Credentials stored in OS keychain\n'))
    } catch (err) {
      console.error(chalk.red('✗ ' + (err instanceof Error ? err.message : 'Login failed')))
      if (err instanceof KeychainUnavailableError) {
        console.error(chalk.gray('  In CI, skip login and export HUSHVAULT_TOKEN.'))
      }
      process.exit(1)
    }
  })
