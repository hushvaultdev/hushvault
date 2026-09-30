import { Command } from 'commander'
import chalk from 'chalk'
import { loadProjectContext, pickEnvInput, resolveEnvironment, type ProjectContext } from '../lib/context.js'
import { fail } from '../lib/fail.js'

export async function getAction(
  ctx: ProjectContext,
  name: string,
  options: { env?: string | undefined; raw?: boolean | undefined },
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<string> {
  const env = await resolveEnvironment(ctx.client, ctx.config.projectId, pickEnvInput(options.env, ctx.config))
  const resolved = await ctx.client.getResolved(env.id)
  const secret = resolved.secrets.find((s) => s.name === name)
  if (!secret || secret.value === null) {
    throw new Error(`Secret "${name}" not found in environment "${env.slug}"`)
  }
  write(options.raw ? secret.value : `${chalk.gray(name + ':')} ${secret.value}\n`)
  return secret.value
}

export const getCommand = new Command('get')
  .description('Get a secret value (applies branch inheritance and computed secrets)')
  .argument('<name>', 'Secret name')
  .option('-e, --env <env>', 'Environment id, slug or name')
  .option('--raw', 'Output raw value only (no formatting, no trailing newline)')
  .action(async (name: string, options: { env?: string; raw?: boolean }) => {
    try {
      await getAction(await loadProjectContext(), name, options)
    } catch (err) {
      fail(err, 'Reading secrets')
    }
  })
