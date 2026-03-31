import { Command } from 'commander'
import chalk from 'chalk'

export const shareCommand = new Command('share')
  .description('Create a temporary E2E encrypted share link for a secret value')
  .argument('<value>', 'Secret value to share')
  .option('--views <n>', 'Max number of views', '1')
  .option('--hours <n>', 'Expiry in hours', '24')
  .action(async (_value: string, _options: { views: string; hours: string }) => {
    // TODO:
    // 1. Generate one-time encryption key (client-side, never sent to server)
    // 2. Encrypt value with the one-time key (AES-GCM via Node.js crypto)
    // 3. POST encrypted payload to /api/share → get token
    // 4. Return: https://hushvault.dev/share/{token}#{base64(oneTimeKey)}
    //    (encryption key is in URL fragment — never sent to server)
    console.log(chalk.yellow('Share links: coming in Phase 2'))
  })
