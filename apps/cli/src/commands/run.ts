import { Command } from 'commander'
import { spawn } from 'child_process'
import ora from 'ora'
import { findProjectConfig } from '../config/project'
import { getAuthToken } from '../config/auth'

export const runCommand = new Command('run')
  .description('Run a command with secrets injected as environment variables')
  .argument('<command>', 'Command to run')
  .argument('[args...]', 'Arguments for the command')
  .option('-e, --env <env>', 'Environment to use (default: from .hushvault.json)')
  .option('--no-inherit', 'Do not inherit current process environment')
  .action(async (command: string, args: string[], options: { env?: string; inherit: boolean }) => {
    const spinner = ora('Fetching secrets...').start()

    try {
      // 1. Find project config
      const result = await findProjectConfig()
      if (!result) {
        spinner.fail('No .hushvault.json found. Run: hushvault init')
        process.exit(1)
      }

      const env = options.env ?? result.config.defaultEnv
      const token = await getAuthToken()

      // 2. Fetch secrets from API
      const response = await fetch(
        `${result.config.apiUrl}/api/secrets?envId=${env}&projectId=${result.config.projectId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )

      if (!response.ok) {
        spinner.fail(`Failed to fetch secrets: ${response.statusText}`)
        process.exit(1)
      }

      const { secrets } = await response.json() as { secrets: Record<string, string> }
      spinner.succeed(`Injecting ${Object.keys(secrets).length} secrets from ${env}`)

      // 3. Merge with process env and spawn
      const childEnv = options.inherit
        ? { ...process.env, ...secrets }
        : { ...secrets, PATH: process.env['PATH'] }

      const child = spawn(command, args, {
        env: childEnv,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })

      child.on('exit', (code) => process.exit(code ?? 0))
      child.on('error', (err) => {
        console.error(`Failed to start command: ${err.message}`)
        process.exit(1)
      })

    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : 'Unknown error')
      process.exit(1)
    }
  })
