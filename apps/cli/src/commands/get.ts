import { Command } from 'commander'
import chalk from 'chalk'
import { findProjectConfig } from '../config/project'
import { getAuthToken } from '../config/auth'

export const getCommand = new Command('get')
  .description('Get a secret value')
  .argument('<name>', 'Secret name')
  .option('-e, --env <env>', 'Environment')
  .option('--raw', 'Output raw value only (no formatting)')
  .action(async (name: string, options: { env?: string; raw: boolean }) => {
    try {
      const result = await findProjectConfig()
      if (!result) throw new Error('Not in a HushVault project. Run: hushvault init')

      const env = options.env ?? result.config.defaultEnv
      const token = await getAuthToken()

      const res = await fetch(
        `${result.config.apiUrl}/api/secrets/${name}?envId=${env}&projectId=${result.config.projectId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )

      if (!res.ok) throw new Error(`Secret not found: ${name}`)
      const { value } = await res.json() as { value: string }

      if (options.raw) {
        process.stdout.write(value)
      } else {
        console.log(`${chalk.gray(name + ':')} ${value}`)
      }
    } catch (err) {
      console.error(chalk.red('✗', err instanceof Error ? err.message : 'Failed'))
      process.exit(1)
    }
  })
