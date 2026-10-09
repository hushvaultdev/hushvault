import { Command } from 'commander'
import chalk from 'chalk'
import { ApiClient, ApiError, friendlyError, type LoginResult, type OrgRow } from '../api.js'
import { storeToken, storeRefreshToken, KeychainUnavailableError } from '../config/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config/project.js'
import { resolveApiUrl } from '../lib/context.js'
import { prompt } from '../lib/prompt.js'
import { resolveOrg } from './orgs.js'

export interface LoginOptions {
  apiUrl?: string | undefined
  email?: string | undefined
  /** Land in this organisation (id or slug) instead of whichever one the login returns. */
  org?: string | undefined
  /** Injected for tests; defaults to interactive prompts (password is not echoed). */
  ask?: (question: string, hidden: boolean) => Promise<string>
}

export interface LoginActionResult {
  email: string
  userId: string
  orgId: string
  /** How many organisations the user belongs to (0 if the list could not be read). */
  orgCount: number
  /** Whether `--org` caused a switch away from the login's default organisation. */
  switched: boolean
}

export async function loginAction(options: LoginOptions = {}): Promise<LoginActionResult> {
  const apiUrl = await resolveApiUrl(options.apiUrl)
  const ask = options.ask ?? ((q, hidden) => prompt(q, hidden))

  const email = (options.email ?? (await ask('Email: ', false))).trim()
  const password = await ask('Password: ', true)
  if (!email || !password) throw new Error('Email and password are required')

  let session: LoginResult
  try {
    session = await new ApiClient({ apiUrl }).login(email, password)
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : friendlyError(err, 'Login')
    throw new Error(`Login failed: ${msg}`)
  }

  // A client bound to the just-minted access token, used to list orgs and (if asked) switch.
  const authed = new ApiClient({ apiUrl, token: session.token })
  let orgs: OrgRow[] | null = null
  let switched = false

  if (options.org) {
    // --org must resolve: failing to read the list or naming an org they're not in is a hard error.
    orgs = await authed.listOrgs()
    const target = resolveOrg(orgs, options.org)
    if (target.id !== session.orgId) {
      // Switch before storing, so we never persist the wrong (default) organisation's session.
      session = await authed.switchOrg(target.id, session.refreshToken)
      switched = true
    }
  } else {
    // Best-effort: only needed for the multi-org hint, so a failure here must not fail the login.
    try {
      orgs = await authed.listOrgs()
    } catch {
      orgs = null
    }
  }

  // Store last (throws KeychainUnavailableError, with guidance, if the keychain can't be used).
  await storeToken(email, session.token)
  if (session.refreshToken) await storeRefreshToken(email, session.refreshToken)
  const existing = await getGlobalConfig()
  const currentOrg = orgs?.find((o) => o.id === session.orgId)?.name
  await saveGlobalConfig({ ...existing, currentUser: email, apiUrl, ...(currentOrg ? { currentOrg } : {}) })

  return { email, userId: session.userId, orgId: session.orgId, orgCount: orgs ? orgs.length : 0, switched }
}

export const loginCommand = new Command('login')
  .description('Authenticate with HushVault')
  .option('--api-url <url>', 'API URL (default: https://api.hushvault.dev)')
  .option('--email <email>', 'Email (prompted if omitted)')
  .option('--org <id|slug>', 'Organisation to land in (for users who belong to more than one)')
  .action(async (options: { apiUrl?: string; email?: string; org?: string }) => {
    try {
      console.log(chalk.bold('\nHushVault Login\n'))
      const { email, orgCount, switched } = await loginAction(options)
      console.log(chalk.green(`\n✓ Logged in as ${email}`))
      console.log(chalk.gray('  Credentials stored in OS keychain'))
      if (options.org && switched) {
        console.log(chalk.gray(`  Switched into organisation "${options.org}"`))
      } else if (!options.org && orgCount > 1) {
        console.log(chalk.gray(`  You belong to ${orgCount} organisations. Switch with \`hushvault orgs use <id|slug>\`.`))
      }
      console.log('')
    } catch (err) {
      console.error(chalk.red('✗ ' + (err instanceof Error ? err.message : 'Login failed')))
      if (err instanceof KeychainUnavailableError) {
        console.error(chalk.gray('  In CI, skip login and export HUSHVAULT_TOKEN.'))
      }
      process.exit(1)
    }
  })
