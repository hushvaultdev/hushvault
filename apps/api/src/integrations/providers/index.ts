import { registerProvider } from '../provider'
import { cloudflareWorkersProvider } from './cloudflare-workers'
import { gitlabProvider } from './gitlab'

/** Register every shipped provider. Called once at startup from src/index.ts; tests may re-register fakes afterwards. */
export function registerProviders(): void {
  registerProvider(cloudflareWorkersProvider)
  registerProvider(gitlabProvider)
  // github-actions is deliberately NOT registered or imported here: libsodium-wrappers probes crypto.getRandomValues at
  // import time, which Workers forbid in global scope, so bundling it fails every deploy with error 10021 ("No secure
  // random number generator found"). The provider module and its tests stay; see the backlog issue under #44.
}
