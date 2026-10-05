import { describe, expect, it } from 'vitest'

import {
  EXPORT_AVAILABLE_NOTE,
  EXPORT_UNAVAILABLE_NOTE,
  EXPORT_UNKNOWN_NOTE,
  type AuditRetention,
  auditExportEntitlement,
  planLabel,
  retentionNote,
} from '../src/lib/audit-export'

function retention(overrides: Partial<AuditRetention> = {}): AuditRetention {
  return { plan: 'free', planMaxDays: 7, overrideDays: null, effectiveDays: 7, ...overrides }
}

describe('auditExportEntitlement', () => {
  it('is unavailable when the server says the plan cannot export', () => {
    const result = auditExportEntitlement(retention({ complianceExport: false }))
    expect(result.state).toBe('unavailable')
    expect(result.note).toBe(EXPORT_UNAVAILABLE_NOTE)
  })

  it('is available when the server says the plan can export', () => {
    const result = auditExportEntitlement(
      retention({ plan: 'team', planMaxDays: 365, effectiveDays: 365, complianceExport: true }),
    )
    expect(result.state).toBe('available')
    expect(result.note).toBe(EXPORT_AVAILABLE_NOTE)
  })

  it('is unknown when retention did not load, or the API predates the field', () => {
    expect(auditExportEntitlement(null)).toEqual({ state: 'unknown', note: EXPORT_UNKNOWN_NOTE })
    expect(auditExportEntitlement(retention()).state).toBe('unknown')
  })

  it('always has a non-empty explanation', () => {
    for (const input of [null, retention(), retention({ complianceExport: false }), retention({ complianceExport: true })]) {
      expect(auditExportEntitlement(input).note.length).toBeGreaterThan(0)
    }
  })

  // The whole point of #92: no copy may suggest the user can buy their way out, because
  // nothing can be bought. These are the words a pricing CTA would bring with it.
  it('never promises an upgrade path', () => {
    for (const note of [EXPORT_UNAVAILABLE_NOTE, EXPORT_AVAILABLE_NOTE, EXPORT_UNKNOWN_NOTE]) {
      expect(note).not.toMatch(/upgrade|contact sales|waitlist|start a trial|buy|subscribe|pricing/i)
    }
  })

  it('points the blocked user at the read path that does work', () => {
    expect(EXPORT_UNAVAILABLE_NOTE).toContain('GET /api/audit')
    expect(EXPORT_UNAVAILABLE_NOTE).toMatch(/not available yet/)
    expect(EXPORT_UNKNOWN_NOTE).toContain('GET /api/audit')
  })
})

describe('retentionNote', () => {
  it('is null when retention is unknown', () => {
    expect(retentionNote(null)).toBeNull()
  })

  it('names the plan when the window comes from the plan cap', () => {
    expect(retentionNote(retention())).toBe(
      'Events are kept for 7 days on the Free plan. Anything older is deleted.',
    )
  })

  // An override narrows what the API shows; the cron sweep deletes by the PLAN window and
  // ignores the override on purpose, so that an admin cannot destroy the trail of their own
  // actions. The note must therefore say "hidden", not "deleted" — and must not claim the
  // events are gone when they are still in D1.
  it('says an override hides events rather than deleting them', () => {
    const note = retentionNote(retention({ overrideDays: 3, effectiveDays: 3 })) as string
    expect(note).toContain('older than 3 days are hidden')
    expect(note).toContain('this organisation’s retention setting')
    expect(note).toContain('still stored')
    expect(note).not.toContain('deleted')
  })

  it('credits the plan when a stale override is clamped by the plan cap', () => {
    // A downgrade can leave an override above the cap; the cap is what queries use, so the
    // note must not blame a setting that is not in force.
    expect(retentionNote(retention({ overrideDays: 365, effectiveDays: 7 }))).toContain('on the Free plan')
  })

  it('says indefinite rather than "-1 days" for unlimited retention', () => {
    const note = retentionNote(retention({ plan: 'enterprise', planMaxDays: -1, effectiveDays: -1 }))
    expect(note).toBe('Events are kept indefinitely on this plan.')
    expect(note).not.toContain('-1')
  })

  it('uses a singular day for a one-day window', () => {
    expect(retentionNote(retention({ overrideDays: 1, effectiveDays: 1 }))).toContain('older than 1 day are')
    expect(retentionNote(retention({ overrideDays: null, effectiveDays: 1, planMaxDays: 1 }))).toContain('for 1 day on the')
  })
})

describe('planLabel', () => {
  it('capitalises the wire value', () => {
    expect(planLabel('free')).toBe('Free')
    expect(planLabel('enterprise')).toBe('Enterprise')
  })

  it('does not produce an empty label for an empty plan', () => {
    expect(planLabel('')).toBe('Unknown')
  })
})
