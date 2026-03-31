import { Command } from 'commander'
import { createInterface } from 'readline'
import chalk from 'chalk'
import { storeToken } from '../config/auth'
import { saveGlobalConfig, DEFAULT_API_URL } from '../config/project'

export const loginCommand = new Command('login')
  .description('Authenticate with HushVault')
  .option('--api-url <url>', 'API URL (default: https://api.hushvault.dev)')
  .action(async (options: { apiUrl?: string }) => {
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res))

    try {
      console.log(chalk.bold('\n🔐 HushVault Login\n'))
      const email = await ask('Email: ')
      const password = await ask('Password: ')
      rl.close()

      const response = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      if (!response.ok) {
        console.error(chalk.red('✗ Login failed:', response.statusText))
        process.exit(1)
      }

      const { token } = await response.json() as { token: string }
      await storeToken(email, token)
      await saveGlobalConfig({ currentUser: email, apiUrl })

      console.log(chalk.green(`\n✓ Logged in as ${email}`))
      console.log(chalk.gray('  Credentials stored in OS keychain\n'))
    } catch (err) {
      rl.close()
      console.error(chalk.red('✗', err instanceof Error ? err.message : 'Login failed'))
      process.exit(1)
    }
  })
