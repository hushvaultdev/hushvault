import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import { describeAdminError } from '../src/lib/admin-errors'

describe('describeAdminError', () => {
  it('maps known admin error codes to human-readable messages', () => {
    expect(describeAdminError(new ApiError(404, 'NOT_FOUND', 'raw'), 'fallback')).toBe('That organisation could not be found.')
    expect(describeAdminError(new ApiError(403, 'FORBIDDEN', 'raw'), 'fallback')).toBe('You do not have permission to do that.')
    expect(describeAdminError(new ApiError(400, 'VALIDATION_ERROR', 'raw'), 'fallback')).toBe('Some of those details could not be used.')
  })

  it('falls back to a generic message for 5xx and unknown codes, and for a non-ApiError', () => {
    expect(describeAdminError(new ApiError(500, 'INTERNAL_ERROR', 'raw'), 'fallback')).toBe('The server had a problem. Try again shortly.')
    expect(describeAdminError(new Error('boom'), 'fallback')).toBe('fallback')
    expect(describeAdminError('not an error', 'fallback')).toBe('fallback')
  })

  it('reports a rate limit and a network failure distinctly', () => {
    expect(describeAdminError(new ApiError(429, 'RATE_LIMITED', 'raw'), 'fallback')).toBe('Too many requests. Wait a moment and try again.')
    expect(describeAdminError(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API.'), 'fallback')).toBe('Could not reach the API.')
  })

  it('uses the API\'s own message for an unmapped 4xx code', () => {
    expect(describeAdminError(new ApiError(409, 'CONFLICT', 'Already handled.'), 'fallback')).toBe('Already handled.')
  })
})
