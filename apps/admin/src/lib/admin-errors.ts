import { ApiError } from './api'

// Mirrors apps/web/src/lib/orgs-helpers.ts's describeOrgError, with wording for the admin routes'
// own error codes (apps/api/src/routes/admin.ts, middleware/access-jwt.ts, middleware/access-binding.ts)
// instead of the dashboard's. A refusal explained in words, never a raw code.
const ADMIN_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'That organisation could not be found.',
  FORBIDDEN: 'You do not have permission to do that.',
  VALIDATION_ERROR: 'Some of those details could not be used.',
  ACCESS_NOT_CONFIGURED: 'The admin app is not fully configured yet. Try again shortly.',
  UNAUTHORIZED: 'Your session has expired. Sign in again.',
}

export function describeAdminError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const known = ADMIN_ERROR_MESSAGES[err.code]
  if (known) return known
  if (err.status === 429) return 'Too many requests. Wait a moment and try again.'
  if (err.status === 0) return err.message
  if (err.status >= 500) return 'The server had a problem. Try again shortly.'
  return err.message || fallback
}
