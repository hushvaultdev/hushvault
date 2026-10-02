import { Command } from 'commander'
import chalk from 'chalk'
import path from 'path'
import { ApiClient, type EnvironmentRow, type ProjectRow } from '../api.js'
import { writeProjectConfig, type HushVaultConfig } from '../config/project.js'
import { createAuthedClient, resolveApiUrl } from '../lib/context.js'
import { fail } from '../lib/fail.js'

function matchProject(projects: ProjectRow[], input: string): ProjectRow | undefined {
  const lower = input.toLowerCase()
  return (
    projects.find((p) => p.id === input) ??
    projects.find((p) => p.slug.toLowerCase() === lower) ??
    projects.find((p) => p.name.toLowerCase() === lower)
  )
}

export async function initAction(
  client: ApiClient,
  apiUrl: string,
  options: { project?: string | undefined; env: string },
  cwd = process.cwd(),
  log: (msg: string) => void = () => {},
): Promise<HushVaultConfig> {
  const projects = await client.listProjects()
  let project: { id: string; name: string }

  if (options.project) {
    const found = matchProject(projects, options.project)
    if (!found) {
      const valid = projects.map((p) => p.slug).join(', ') || '(none)'
      throw new Error(`Project "${options.project}" not found. Available projects: ${valid}`)
    }
    project = found
    log(`Using project: ${found.name}`)
  } else {
    const dirName = path.basename(cwd) || 'my-project'
    const found = matchProject(projects, dirName)
    if (found) {
      project = found
      log(`Using existing project: ${found.name}`)
    } else {
      project = await client.createProject({ name: dirName })
      log(`Created project: ${project.name}`)
    }
  }

  const envs = await client.listEnvironments(project.id)
  const lower = options.env.toLowerCase()
  let env: { slug: string } | undefined =
    envs.find((e: EnvironmentRow) => e.id === options.env) ??
    envs.find((e) => e.slug.toLowerCase() === lower) ??
    envs.find((e) => e.name.toLowerCase() === lower)
  if (!env) {
    env = await client.createEnvironment({ projectId: project.id, name: options.env })
    log(`Created environment: ${env.slug}`)
  }

  const config: HushVaultConfig = {
    apiUrl,
    projectId: project.id,
    projectName: project.name,
    defaultEnv: env.slug,
    createdAt: new Date().toISOString(),
  }
  await writeProjectConfig(config, cwd)
  return config
}

export const initCommand = new Command('init')
  .description('Link current directory to a HushVault project (creates project/environment if needed)')
  .option('--project <project>', 'Existing project id, slug or name (default: project named after this directory, created if missing)')
  .option('--env <env>', 'Default environment id, slug or name', 'development')
  .option('--api-url <url>', 'API URL')
  .action(async (options: { project?: string; env: string; apiUrl?: string }) => {
    try {
      const apiUrl = await resolveApiUrl(options.apiUrl)
      const client = await createAuthedClient(apiUrl)
      await initAction(client, apiUrl, options, process.cwd(), (m) => console.log(chalk.green(`✓ ${m}`)))
      console.log(chalk.green('✓ Initialized .hushvault.json'))
      console.log(chalk.gray('  Commit .hushvault.json to git (it contains no secrets)\n'))
    } catch (err) {
      fail(err, 'Setting up projects/environments')
    }
  })
