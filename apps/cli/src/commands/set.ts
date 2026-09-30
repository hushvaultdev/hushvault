import { Command } from 'commander'
import chalk from 'chalk'
import { loadProjectContext, pickEnvInput, readStdin, resolveEnvironment, stripTrailingNewline, type ProjectContext } from '../lib/context.js'
import { prompt } from '../lib/prompt.js'
import { fail } from '../lib/fail.js'

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Value from the CLI arg, or stdin (piped, or hidden prompt on a TTY) when omitted or `-`. */
export async function readValue(arg: string | undefined, stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (arg !== undefined && arg !== '-') return arg
  if (stdin.isTTY) return prompt('Value (hidden): ', true)
  return stripTrailingNewline(await readStdin(stdin))
}

export async function setAction(
  ctx: ProjectContext,
  name: string,
  value: string,
  options: { env?: string | undefined },
): Promise<{ created: boolean; env: string }> {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error('Invalid secret name: use letters, digits and underscores, not starting with a digit (e.g. DATABASE_URL)')
  }
  const env = await resolveEnvironment(ctx.client, ctx.config.projectId, pickEnvInput(options.env, ctx.config))
  const existing = (await ctx.client.listSecrets(ctx.config.projectId, env.id)).find((s) => s.name === name)
  if (existing) {
    await ctx.client.updateSecret(existing.id, { value })
    return { created: false, env: env.slug }
  }
  await ctx.client.createSecret({ projectId: ctx.config.projectId, envId: env.id, name, value })
  return { created: true, env: env.slug }
}

export const setCommand = new Command('set')
  .description('Create or update a secret. Omit VALUE (or pass -) to read it from stdin.')
  .argument('<name>', 'Secret name (e.g. DATABASE_URL)')
  .argument('[value]', 'Secret value (omit or "-" to read from stdin)')
  .option('-e, --env <env>', 'Environment id, slug or name')
  .action(async (name: string, valueArg: string | undefined, options: { env?: string }) => {
    try {
      const ctx = await loadProjectContext()
      const value = await readValue(valueArg)
      const { created, env } = await setAction(ctx, name, value, options)
      console.log(chalk.green(`✓ ${created ? 'Created' : 'Updated'} ${name} in ${env}`))
    } catch (err) {
      fail(err, 'Writing secrets')
    }
  })
