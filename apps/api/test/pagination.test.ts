import { describe, expect, it } from 'vitest'
import { decodeKeysetCursor, encodeKeysetCursor } from '../src/lib/pagination'

describe('encodeKeysetCursor / decodeKeysetCursor', () => {
  it('round-trips a plausible created_at and id pair', () => {
    const createdAt = '2026-10-15T09:28:00.000Z'
    const id = 'org_abc123DEF456'
    const encoded = encodeKeysetCursor(createdAt, id)
    expect(decodeKeysetCursor(encoded)).toEqual({ createdAt, id })
  })

  it('produces a URL-safe cursor (no +, /, or trailing =)', () => {
    // Pick inputs that will almost certainly produce + or / in standard base64.
    const encoded = encodeKeysetCursor('2026-10-15T09:28:00.000Z', 'org_?><>+/==')
    expect(encoded).not.toMatch(/[+/=]/)
  })

  it('returns null on anything malformed, never throws', () => {
    expect(decodeKeysetCursor('not-base64-!!')).toBeNull()
    // Decodes successfully but has no separator -> null.
    expect(decodeKeysetCursor(Buffer.from('no-pipe-here').toString('base64url'))).toBeNull()
    // Separator at index 0 means an empty createdAt — treated as malformed.
    expect(decodeKeysetCursor(Buffer.from('|org_x').toString('base64url'))).toBeNull()
    expect(decodeKeysetCursor('')).toBeNull()
  })

  it('splits on the LAST pipe, so a createdAt with embedded | is preserved as long as id has none', () => {
    // The codec's contract: id must not contain '|'. createdAt may (lastIndexOf separator). Current
    // id generator (createPrefixedId, base64url) never produces one, so this is safe in practice.
    const createdAt = 'strange|but|possible'
    const id = 'org_abc123'
    const encoded = encodeKeysetCursor(createdAt, id)
    expect(decodeKeysetCursor(encoded)).toEqual({ createdAt, id })
  })
})
