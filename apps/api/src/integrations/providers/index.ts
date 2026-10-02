import { registerProvider } from '../provider'
import { cloudflareWorkersProvider } from './cloudflare-workers'

/** Register every shipped provider. Called once at startup from src/index.ts; tests may re-register fakes afterwards. */
export function registerProviders(): void {
  registerProvider(cloudflareWorkersProvider)
}
