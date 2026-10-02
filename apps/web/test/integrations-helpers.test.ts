import type { SyncPlanDto } from '@hushvault/shared/integrations'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../src/lib/api'
import { autoSyncText, describeApiError, groupPlan, needsAttentionSteps, parseScheduleValue, retryText, runErrorGuidance, scheduleOptions, scheduleValue, triggerLabel } from '../src/lib/integrations-helpers'

describe('describeApiError', () => {
  it('shows the API message for CONFLICT instead of a label message', () => {
    const err = new ApiError(409, 'CONFLICT', 'That resource is already a sync target')
    expect(describeApiError(err, 'x')).toBe('That resource is already a sync target')
  })

  it('maps sync error codes', () => {
    for (const code of ['PROVIDER_AUTH', 'PROVIDER_RATE_LIMIT', 'PROVIDER_VALIDATION', 'PROVIDER_ERROR', 'TARGET_NOT_FOUND', 'COMPUTED_ERROR', 'CREDENTIAL_UNAVAILABLE', 'TIMEOUT', 'SYNC_BLOCKED', 'PLAN_LIMIT']) {
      const msg = describeApiError(new ApiError(code === 'PLAN_LIMIT' ? 409 : 502, code, 'raw'), 'fallback')
      expect(msg, code).not.toBe('raw')
      expect(msg, code).not.toBe('fallback')
    }
  })

  it('handles 502 provider codes before the generic 5xx branch', () => {
    expect(describeApiError(new ApiError(502, 'PROVIDER_AUTH', 'x'), 'f')).toMatch(/credential/)
    expect(describeApiError(new ApiError(502, 'WHATEVER', 'x'), 'f')).toMatch(/provider/)
    expect(describeApiError(new ApiError(500, 'INTERNAL_ERROR', 'x'), 'f')).toMatch(/server/)
  })

  it('falls back for non-API errors', () => {
    expect(describeApiError(new Error('boom'), 'fallback')).toBe('fallback')
  })
})

describe('runErrorGuidance', () => {
  it('is null without a code and never empty with one', () => {
    expect(runErrorGuidance(null)).toBeNull()
    expect(runErrorGuidance('TIMEOUT')).toMatch(/timed out/)
    expect(runErrorGuidance('NEW_CODE')).toContain('NEW_CODE')
  })
})

describe('groupPlan', () => {
  const plan: SyncPlanDto = { create: ['A'], update: [], delete: ['B'], skip: [], conflict: ['C'], blockers: [] }
  it('returns only non-empty groups in display order, names only', () => {
    const groups = groupPlan(plan)
    expect(groups.map((g) => g.key)).toEqual(['create', 'delete', 'conflict'])
    expect(groups[0]?.names).toEqual(['A'])
  })
  it('returns nothing for an empty plan', () => {
    expect(groupPlan({ create: [], update: [], delete: [], skip: [], conflict: [], blockers: [] })).toEqual([])
  })
})

describe('auto-sync helpers', () => {
  it('lists Off plus every schedule option', () => {
    expect(scheduleOptions().map((o) => o.value)).toEqual(['', '15', '60', '360', '1440'])
  })

  it('round-trips schedule values and rejects unknown ones', () => {
    expect(parseScheduleValue('')).toBeNull()
    expect(parseScheduleValue('60')).toBe(60)
    expect(parseScheduleValue('7')).toBeNull()
    expect(scheduleValue(360)).toBe('360')
    expect(scheduleValue(null)).toBe('')
    expect(scheduleValue(7)).toBe('')
    expect(scheduleValue(undefined)).toBe('')
  })

  it('describes auto-sync settings', () => {
    expect(autoSyncText({ onChange: false, scheduleMinutes: null })).toBe('off')
    expect(autoSyncText(undefined)).toBe('off')
    expect(autoSyncText({ onChange: true, scheduleMinutes: null })).toBe('on change')
    expect(autoSyncText({ onChange: true, scheduleMinutes: 60 })).toBe('on change, hourly')
    expect(autoSyncText({ onChange: false, scheduleMinutes: 1440 })).toBe('daily')
  })

  it('labels triggers and retry times', () => {
    expect(triggerLabel('change')).toBe('Secret change')
    expect(triggerLabel('other')).toBe('other')
    expect(retryText(null)).toBeNull()
    expect(retryText('garbage')).toBeNull()
    expect(retryText('2026-01-01T00:00:00.000Z')).toMatch(/^Will retry at /)
  })

  it('gives needs-attention steps covering credential, edit and remove', () => {
    const text = needsAttentionSteps().join(' ')
    expect(text).toMatch(/Rotate the connection credential/)
    expect(text).toMatch(/Edit the target/)
    expect(text).toMatch(/remove the target/)
  })
})
