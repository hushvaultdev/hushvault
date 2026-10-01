import { describe, expect, it } from 'vitest'
import { evaluateSecrets, extractPlaceholders, type ResolveInput } from '../src/lib/resolve'

const plain = (name: string, value: string): ResolveInput => ({ name, isComputed: false, template: null, value })
const comp = (name: string, template: string): ResolveInput => ({ name, isComputed: true, template })

describe('evaluateSecrets', () => {
  it('substitutes placeholders', () => {
    const r = evaluateSecrets([plain('U', 'bob'), plain('P', 'pw'), comp('URL', 'postgres://${U}:${P}@host/db')])
    expect(r.ok && r.values.get('URL')).toBe('postgres://bob:pw@host/db')
  })

  it('supports chains regardless of input order', () => {
    const r = evaluateSecrets([comp('C', '${B}-c'), comp('B', '${A}-b'), plain('A', 'a')])
    expect(r.ok && r.values.get('C')).toBe('a-b-c')
  })

  it('detects direct and indirect cycles', () => {
    const self = evaluateSecrets([comp('A', '${A}')])
    expect(self).toMatchObject({ ok: false, error: { code: 'CIRCULAR', secret: 'A' } })
    const ind = evaluateSecrets([comp('A', '${B}'), comp('B', '${A}')])
    expect(ind).toMatchObject({ ok: false, error: { code: 'CIRCULAR' } })
  })

  it('reports missing references by name only', () => {
    const r = evaluateSecrets([plain('X', 'topsecret'), comp('A', '${X}${NOPE}')])
    expect(r).toEqual({ ok: false, error: { code: 'MISSING', secret: 'A', reference: 'NOPE' } })
    expect(JSON.stringify(r)).not.toContain('topsecret')
  })

  it('leaves a bare $ and unterminated ${ alone', () => {
    const r = evaluateSecrets([plain('A', 'x'), comp('B', 'cost $5 $A $ {A} ${A')])
    expect(r.ok && r.values.get('B')).toBe('cost $5 $A $ {A} ${A')
  })

  it('rejects invalid placeholder names', () => {
    for (const t of ['${1A}', '${A B}', '${}', '${A-B}']) {
      expect(evaluateSecrets([plain('A', 'x'), comp('B', t)])).toMatchObject({ ok: false, error: { code: 'INVALID_REFERENCE', secret: 'B' } })
    }
  })

  it('does not substitute inside resolved values (no re-expansion)', () => {
    const r = evaluateSecrets([plain('A', '${B}'), plain('B', 'b'), comp('C', '${A}')])
    expect(r.ok && r.values.get('C')).toBe('${B}')
  })

  it('does not explode on exponential fan-out', () => {
    const inputs: ResolveInput[] = [plain('S0', 'xxxxxxxxxx')]
    for (let i = 1; i <= 40; i++) inputs.push(comp(`S${i}`, `\${S${i - 1}}\${S${i - 1}}`))
    const r = evaluateSecrets(inputs)
    expect(r).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } })
  })

  it('caps nesting depth without stack overflow', () => {
    const inputs: ResolveInput[] = [plain('N0', 'v')]
    for (let i = 1; i <= 5000; i++) inputs.push(comp(`N${i}`, `\${N${i - 1}}`))
    // Start from the deepest secret so nothing is memoised yet.
    expect(evaluateSecrets(inputs.reverse())).toMatchObject({ ok: false, error: { code: 'TOO_DEEP' } })
  })

  it('extractPlaceholders', () => {
    expect(extractPlaceholders('${A} ${b1} ${1x} $C')).toEqual(['A', 'b1', null])
  })
})
