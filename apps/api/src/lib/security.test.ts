import { describe, expect, it } from 'vitest'
import { assertSecretSize, getRequestIp, MAX_SECRET_VALUE_BYTES } from './security'

describe('assertSecretSize', () => {
  it('accepts an empty string', () => {
    expect(() => assertSecretSize('')).not.toThrow()
  })

  it('accepts a value at exactly the 64KB limit', () => {
    expect(() => assertSecretSize('a'.repeat(MAX_SECRET_VALUE_BYTES))).not.toThrow()
  })

  it('rejects a value one byte over the limit', () => {
    expect(() => assertSecretSize('a'.repeat(MAX_SECRET_VALUE_BYTES + 1))).toThrow(
      'Secret value exceeds 64KB limit',
    )
  })

  it('measures byte length, not character count (multi-byte UTF-8)', () => {
    // '✓' is 3 bytes in UTF-8. A string of ~22k of them exceeds 64KB in bytes
    // while being well under 64KB in characters.
    const value = '✓'.repeat(Math.ceil((MAX_SECRET_VALUE_BYTES + 1) / 3))
    expect(value.length).toBeLessThan(MAX_SECRET_VALUE_BYTES)
    expect(() => assertSecretSize(value)).toThrow('Secret value exceeds 64KB limit')
  })
})

describe('getRequestIp', () => {
  const ctx = (headers: Record<string, string | undefined>) => ({
    req: { header: (name: string) => headers[name] },
  })

  it('prefers cf-connecting-ip', () => {
    expect(getRequestIp(ctx({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }))).toBe('1.2.3.4')
  })

  it('falls back to x-forwarded-for', () => {
    expect(getRequestIp(ctx({ 'x-forwarded-for': '9.9.9.9' }))).toBe('9.9.9.9')
  })

  it('returns null when no ip header is present', () => {
    expect(getRequestIp(ctx({}))).toBeNull()
  })
})
