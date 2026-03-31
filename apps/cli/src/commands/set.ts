import { Command } from 'commander'
import chalk from 'chalk'
import { findProjectConfig } from '../config/project'
import { getAuthToken } from '../config/auth'

export const setCommand = new Command('set')
  .description('Set a secret value')
  .argument('<name>', 'Secret name (e.g. DATABASE_URL)')
  .argument('<value>', 'Secret value')
  .option('-e, --env <env>', 'Environment')
  .action(async (name: string, value: string, options: { env?: string }) => {
    try {
      const result = await findProjectConfig()
      if (!result) throw new Error('Not in a HushVault project. Run: hushvault init')

      const env = options.env ?? result.config.defaultEnv
      const token = await getAuthToken()

      const res = await fetch(`${result.config.apiUrl}/api/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, value, envId: env, projectId: result.config.projectId }),
      })

      if (!res.ok) throw new Error(`Failed to set secret: ${res.statusText}`)
      console.log(chalk.green(`✓ Set ${name} in ${env}`))
    } catch (err) {
      console.error(chalk.red('✗', err instanceof Error ? err.message : 'Failed'))
      process.exit(1)
    }
  })
