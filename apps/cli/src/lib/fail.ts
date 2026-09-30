import chalk from 'chalk'
import { friendlyError } from '../api.js'

/** Print an error and exit non-zero. Never prints secret values. */
export function fail(err: unknown, action?: string): never {
  console.error(chalk.red('✗ ' + friendlyError(err, action)))
  process.exit(1)
}
