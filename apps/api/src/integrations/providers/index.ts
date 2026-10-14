import { registerProvider } from '../provider'
import { cloudflareWorkersProvider } from './cloudflare-workers'
import { githubActionsProvider } from './github-actions'
import { gitlabProvider } from './gitlab'

/** Register every shipped provider. Called once at startup from src/index.ts; tests may re-register fakes afterwards. */
export function registerProviders(): void {
  registerProvider(cloudflareWorkersProvider)
  registerProvider(gitlabProvider)
  // Registered so a live e2e can run against a real repo; the registry keeps github-actions `planned` (not a
  // claimed feature) until that evidence is recorded on issue #44.
  registerProvider(githubActionsProvider)
}
