// Pure evaluation of computed secrets (`${NAME}` templates). No I/O, no logging.
// Errors carry secret NAMES only, never values.

export const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const MAX_REFERENCE_DEPTH = 64
export const MAX_VALUE_LENGTH = 262_144

export type ResolveInput = {
  name: string
  isComputed: boolean
  template: string | null
  /** Plaintext value for non-computed secrets. */
  value?: string
}

export type ComputedErrorCode = 'CIRCULAR' | 'MISSING' | 'INVALID_REFERENCE' | 'TOO_DEEP' | 'TOO_LARGE'

export type ComputedError = {
  code: ComputedErrorCode
  secret: string
  reference?: string
}

export type ComputedResult =
  | { ok: true; values: Map<string, string> }
  | { ok: false; error: ComputedError }

export function describeComputedError(e: ComputedError): string {
  switch (e.code) {
    case 'CIRCULAR':
      return `Computed secret ${e.secret} has a circular reference via ${e.reference ?? e.secret}`
    case 'MISSING':
      return `Computed secret ${e.secret} references missing secret ${e.reference ?? ''}`.trim()
    case 'INVALID_REFERENCE':
      return `Computed secret ${e.secret} contains an invalid placeholder name`
    case 'TOO_DEEP':
      return `Computed secret ${e.secret} has too many nested references`
    case 'TOO_LARGE':
      return `Computed secret ${e.secret} expands to a value that is too large`
  }
}

class EvalError extends Error {
  constructor(readonly detail: ComputedError) {
    super(detail.code)
  }
}

/** Names referenced by `${NAME}` placeholders in a template, in order (may repeat). Invalid names yield null entries. */
export function extractPlaceholders(template: string): Array<string | null> {
  const out: Array<string | null> = []
  for (const m of template.matchAll(/\$\{([^}]*)\}/g)) {
    const inner = m[1] ?? ''
    out.push(PLACEHOLDER_NAME.test(inner) ? inner : null)
  }
  return out
}

/**
 * Evaluate every computed secret against the given set. Non-computed secrets
 * keep their `value`. Memoised, so shared references are evaluated once.
 */
export function evaluateSecrets(inputs: ResolveInput[]): ComputedResult {
  const byName = new Map<string, ResolveInput>()
  for (const s of inputs) byName.set(s.name, s)
  const values = new Map<string, string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const resolve = (name: string): string => {
    const cached = values.get(name)
    if (cached !== undefined) return cached
    const secret = byName.get(name)
    if (!secret) throw new Error('unreachable')
    if (!secret.isComputed) {
      const v = secret.value ?? ''
      values.set(name, v)
      return v
    }
    if (onStack.has(name)) throw new EvalError({ code: 'CIRCULAR', secret: name, reference: name })
    if (stack.length >= MAX_REFERENCE_DEPTH) throw new EvalError({ code: 'TOO_DEEP', secret: name })
    stack.push(name)
    onStack.add(name)
    try {
      const template = secret.template ?? ''
      let result = ''
      let last = 0
      for (const m of template.matchAll(/\$\{([^}]*)\}/g)) {
        const inner = m[1] ?? ''
        result += template.slice(last, m.index)
        last = (m.index ?? 0) + m[0].length
        if (!PLACEHOLDER_NAME.test(inner)) {
          throw new EvalError({ code: 'INVALID_REFERENCE', secret: name })
        }
        if (!byName.has(inner)) throw new EvalError({ code: 'MISSING', secret: name, reference: inner })
        if (onStack.has(inner)) throw new EvalError({ code: 'CIRCULAR', secret: name, reference: inner })
        result += resolve(inner)
        if (result.length > MAX_VALUE_LENGTH) throw new EvalError({ code: 'TOO_LARGE', secret: name })
      }
      result += template.slice(last)
      if (result.length > MAX_VALUE_LENGTH) throw new EvalError({ code: 'TOO_LARGE', secret: name })
      values.set(name, result)
      return result
    } finally {
      stack.pop()
      onStack.delete(name)
    }
  }

  try {
    for (const s of inputs) resolve(s.name)
  } catch (err) {
    if (err instanceof EvalError) return { ok: false, error: err.detail }
    throw err
  }
  return { ok: true, values }
}
