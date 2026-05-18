#!/usr/bin/env node

import { Command } from 'commander'
import { loginCommand } from './commands/login.js'
import { initCommand } from './commands/init.js'
import { runCommand } from './commands/run.js'
import { getCommand } from './commands/get.js'
import { setCommand } from './commands/set.js'
import { shareCommand } from './commands/share.js'

const program = new Command()

program
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

program.parse(process.argv)
