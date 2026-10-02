import { Command } from 'commander'
import { spawn } from 'child_process'
import os from 'os'
import ora from 'ora'
import { loadProjectContext, pickEnvInput, resolveEnvironment, type ProjectContext } from '../lib/context.js'
import { fail } from '../lib/fail.js'

export async function fetchSecretEnv(ctx: ProjectContext, envInput: string): Promise<{ env: string; secrets: Record<string, string> }> {
  const env = await resolveEnvironment(ctx.client, ctx.config.projectId, envInput)
  const resolved = await ctx.client.getResolved(env.id)
  const secrets: Record<string, string> = {}
  for (const s of resolved.secrets) {
    if (typeof s.value === 'string') secrets[s.name] = s.value
  }
  return { env: env.slug, secrets }
}

export function buildChildEnv(secrets: Record<string, string>, inherit: boolean): NodeJS.ProcessEnv {
  if (inherit) {
    // The child must not receive HushVault's own credentials just because it is spawned by the CLI.
    const parent = { ...process.env }
    for (const k of Object.keys(parent)) if (k.startsWith('HUSHVAULT_')) delete parent[k]
    return { ...parent, ...secrets }
  }
  const base: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE']) {
    const v = process.env[k]
    if (v !== undefined) base[k] = v
  }
  return { ...base, ...secrets }
}

/** Spawn a command, forwarding SIGINT/SIGTERM; resolves with the exit code (128+n for signals). */
export function spawnWithEnv(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' })
    const signals = ['SIGINT', 'SIGTERM'] as const
    const handlers = signals.map((sig) => {
      const h = () => {
        child.kill(sig)
      }
      process.on(sig, h)
      return [sig, h] as const
    })
    const cleanup = () => handlers.forEach(([sig, h]) => process.off(sig, h))
    child.on('error', (err) => {
      cleanup()
      reject(new Error(`Failed to start command "${command}": ${err.message}`))
    })
    child.on('exit', (code, signal) => {
      cleanup()
      if (code !== null) return resolve(code)
      const num = signal ? (os.constants.signals[signal] ?? 0) : 0
      resolve(128 + num)
    })
  })
}

export async function runAction(
  ctx: ProjectContext,
  command: string,
  args: string[],
  options: { env?: string | undefined; inherit?: boolean | undefined },
  log: (msg: string) => void = () => {},
): Promise<number> {
  const { env, secrets } = await fetchSecretEnv(ctx, pickEnvInput(options.env, ctx.config))
  log(`Injecting ${Object.keys(secrets).length} secrets from ${env}`)
  return spawnWithEnv(command, args, buildChildEnv(secrets, options.inherit !== false))
}

export const runCommand = new Command('run')
  .description('Run a command with secrets injected as environment variables')
  .argument('<command>', 'Command to run')
  .argument('[args...]', 'Arguments for the command')
  .option('-e, --env <env>', 'Environment id, slug or name (default: from .hushvault.json)')
  .option('--no-inherit', 'Do not inherit current process environment')
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (command: string, args: string[], options: { env?: string; inherit: boolean }) => {
    const spinner = ora({ text: 'Fetching secrets...', stream: process.stderr }).start()
    try {
      const ctx = await loadProjectContext()
      const { env, secrets } = await fetchSecretEnv(ctx, pickEnvInput(options.env, ctx.config))
      spinner.succeed(`Injecting ${Object.keys(secrets).length} secrets from ${env}`)
      const code = await spawnWithEnv(command, args, buildChildEnv(secrets, options.inherit))
      process.exit(code)
    } catch (err) {
      spinner.stop()
      fail(err, 'Reading secrets')
    }
  })
