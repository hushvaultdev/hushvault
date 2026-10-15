import { registerProvider } from '../provider'
import { cloudflareWorkersProvider } from './cloudflare-workers'
import { gitlabProvider } from './gitlab'

/** Register every shipped provider. Called once at startup from src/index.ts; tests may re-register fakes afterwards. */
export function registerProviders(): void {
  registerProvider(cloudflareWorkersProvider)
  registerProvider(gitlabProvider)
  // cloudflare-pages is deliberately NOT registered or imported here (issue #110, found during the #108 review).
  // The registry marks Pages as `planned`, but nothing in the connect/run path reads that status field — so any
  // registered provider is fully connectable, and cloudflare-pages.ts's own header admits its PATCH behavior
  // against deployment_configs is unverified against a live project and could wipe a project's bindings if PATCH
  // replaces instead of merges. The module and its tests stay for #45's live e2e drill; re-register it once that
  // drill records real evidence.
  // github-actions is deliberately NOT registered or imported here: libsodium-wrappers probes crypto.getRandomValues at
  // import time, which Workers forbid in global scope, so bundling it fails every deploy with error 10021 ("No secure
  // random number generator found"). The provider module and its tests stay; see the backlog issue under #44.
}
