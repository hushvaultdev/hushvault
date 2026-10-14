import { createApiClient, ApiError } from '@hushvault/web-kit/client'
import { sessionStore } from './auth-storage'
import type { Session } from './types'

export { ApiError }

// The refresh, retry and error handling are the shared client's (packages/web-kit); this binds it
// to the admin app: same-origin (the proxy under src/app/api/**, issue #108 finding 2), its
// Session shape, and the client header the API's requirePlatformAdmin-adjacent middleware and
// audit log can tell apart from the dashboard and the CLI.
const client = createApiClient<Session>({
  apiBase: '', // same-origin: the browser only ever talks to this app's own Worker, never the API origin directly
  clientName: 'admin',
  store: sessionStore,
  sessionFromRefresh: (data) => {
    if (typeof data['token'] !== 'string' || typeof data['userId'] !== 'string') return null
    return { token: data['token'], userId: data['userId'] }
  },
  signInPath: '/sign-in',
})

export const { apiFetch, apiFetchEnvelope, refreshSession, endSession } = client
