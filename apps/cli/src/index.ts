#!/usr/bin/env node

import { Command } from 'commander'
import { loginCommand } from './commands/login.js'
import { initCommand } from './commands/init.js'
import { runCommand } from './commands/run.js'
import { getCommand } from './commands/get.js'
import { setCommand } from './commands/set.js'
import { shareCommand } from './commands/share.js'
import { syncCommand } from './commands/sync.js'

const program = new Command()

program
  .enablePositionalOptions()
  .name('hushvault')
  .description('HushVault — secrets manager for Cloudflare developers')
  .version('0.0.1')
  .alias('hv')

program.addCommand(loginCommand)
program.addCommand(initCommand)
program.addCommand(runCommand)
program.addCommand(getCommand)
program.addCommand(setCommand)
program.addCommand(shareCommand)
program.addCommand(syncCommand)

program.parse(process.argv)
