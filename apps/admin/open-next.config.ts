import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// No incremental cache override (client-rendered, no ISR). See apps/web/open-next.config.ts.
export default defineCloudflareConfig()
