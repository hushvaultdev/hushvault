import { Command } from 'commander'
import chalk from 'chalk'
import { writeProjectConfig, DEFAULT_API_URL } from '../config/project'
import { getAuthToken } from '../config/auth'

export const initCommand = new Command('init')
  .description('Link current directory to a HushVault project')
  .option('--project <id>', 'Existing project ID (creates new project if omitted)')
  .option('--env <env>', 'Default environment', 'development')
  .action(async (options: { project?: string; env: string }) => {
    try {
      const token = await getAuthToken()
      const apiUrl = DEFAULT_API_URL

      let projectId = options.project
      let projectName = ''

      if (!projectId) {
        // Create new project from directory name
        const dirName = process.cwd().split(/[\\/]/).pop() ?? 'my-project'
        const res = await fetch(`${apiUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: dirName }),
        })
        if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`)
        const data = await res.json() as { id: string; name: string }
        projectId = data.id
        projectName = data.name
        console.log(chalk.green(`✓ Created project: ${projectName}`))
      }

      await writeProjectConfig({
        projectId,
        projectName,
        defaultEnv: options.env,
        apiUrl,
        createdAt: new Date().toISOString(),
      })

      console.log(chalk.green('✓ Initialized .hushvault.json'))
      console.log(chalk.gray(`  Commit .hushvault.json to git (it contains no secrets)\n`))
    } catch (err) {
      console.error(chalk.red('✗', err instanceof Error ? err.message : 'Init failed'))
      process.exit(1)
    }
  })
