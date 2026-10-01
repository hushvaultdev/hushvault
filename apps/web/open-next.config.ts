import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// Default config: no incremental cache override (the dashboard is client-rendered
// and has no ISR). Add an R2/KV cache here only if ISR is introduced.
// See https://opennext.js.org/cloudflare/caching
export default defineCloudflareConfig()
