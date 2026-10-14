import { createSessionStore } from '@hushvault/web-kit/client'
import type { Session } from './types'

// The session holder and hint live in the shared kit (packages/web-kit); this binds them to the
// admin app's Session shape and its own hint key. The access token is in-memory only; persistence
// comes from the API's HttpOnly refresh cookie (scoped to this origin via the admin proxy,
// issue #108 finding 2).
//
// hintKey is deliberately distinct from the dashboard's 'hv_has_session': both apps could run in
// the same browser profile, and a shared key would make one app's sign-out/sign-in toggle the
// other's cold-load refresh attempt for no reason.
export const sessionStore = createSessionStore<Session>({ hintKey: 'hv_admin_has_session' })

export const readSession = sessionStore.read
export const writeSession = sessionStore.write
export const clearSession = sessionStore.clear
export const subscribeSession = sessionStore.subscribe
export const markSessionHint = sessionStore.markHint
export const hasSessionHint = sessionStore.hasHint
