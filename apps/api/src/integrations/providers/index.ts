import { registerProvider } from '../provider'
import { cloudflarePagesProvider } from './cloudflare-pages'
import { cloudflareWorkersProvider } from './cloudflare-workers'
import { githubActionsProvider } from './github-actions'
import { gitlabProvider } from './gitlab'

/** Register every shipped provider. Called once at startup from src/index.ts; tests may re-register fakes afterwards. */
export function registerProviders(): void {
  registerProvider(cloudflareWorkersProvider)
  registerProvider(gitlabProvider)
  registerProvider(githubActionsProvider)
  // cloudflare-pages is registered so the module loads and its sync-engine wiring compiles, but it
  // stays `planned` in packages/shared/src/integrations.ts and the connect-path gate in
  // getConnectableProvider refuses it. This is the full #110 fix (b0874d4 only unregistered it):
  // the status field is now a real gate, so promoting Pages to `beta` after #45's live e2e drill
  // records PATCH's merge-vs-replace behavior opens the gate automatically. Any future `planned`
  // provider (webhooks, slack) can be registered the same way for internal drills without being
  // publicly reachable.
  registerProvider(cloudflarePagesProvider)
}
