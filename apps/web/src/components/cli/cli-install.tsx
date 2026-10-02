import { Card } from '@/components/ui/card'

import styles from './cli-install.module.css'

const s = (name: string) => styles[name]

export const CLI_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: 'Install the HushVault CLI globally', command: 'npm install -g hushvault' },
  { label: 'Authenticate with your account', command: 'hushvault login' },
  { label: 'Link this directory to a project', command: 'hushvault init' },
]

/** The install/login/init commands. Shared by the onboarding wizard and the dashboard. */
export function CliInstallSteps() {
  return (
    <ul className={s('cliList')}>
      {CLI_COMMANDS.map(({ label, command }) => (
        <li className={s('cliStep')} key={command}>
          <span className={s('cliStepLabel')}>{label}</span>
          <code className={s('cliCommand')}>{command}</code>
        </li>
      ))}
    </ul>
  )
}

/** Always-available CLI instructions, independent of how many projects exist. */
export function CliInstallCard() {
  return (
    <Card className={s('panel')} tone="light">
      <div>
        <h2 className={s('title')}>Install the CLI</h2>
        <p className={s('subtitle')}>Pull secrets into any environment straight from your terminal.</p>
      </div>
      <CliInstallSteps />
    </Card>
  )
}
