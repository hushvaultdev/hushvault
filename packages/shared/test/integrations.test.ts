import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INTEGRATIONS, promotionEvidence, type IntegrationInfo } from '../src/integrations'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Why an entry may not be beta/available yet. Empty array = allowed. */
export function missingPromotionEvidence(entry: Pick<IntegrationInfo, 'id' | 'status'>, exists: (path: string) => boolean): string[] {
  if (entry.status === 'planned') return []
  const need = promotionEvidence(entry.id)
  return Object.values(need).filter((p) => !exists(p))
}

describe('registry', () => {
  it('has unique ids and honest wording for anything not available', () => {
    expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length)
    for (const i of INTEGRATIONS.filter((x) => x.status === 'planned')) {
      expect(i.summary, i.id).toMatch(/^Planned/)
    }
  })

  it('status promotion gate: beta/available needs a provider module, a test file and a docs page', () => {
    for (const i of INTEGRATIONS) {
      expect(missingPromotionEvidence(i, (p) => existsSync(join(ROOT, p))), `${i.id} is ${i.status} without evidence`).toEqual([])
    }
  })

  it('the gate itself rejects an unevidenced promotion', () => {
    expect(missingPromotionEvidence({ id: 'cloudflare-workers', status: 'beta' }, () => false)).toHaveLength(3)
    expect(missingPromotionEvidence({ id: 'cloudflare-workers', status: 'beta' }, () => true)).toEqual([])
    expect(missingPromotionEvidence({ id: 'cloudflare-workers', status: 'planned' }, () => false)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Copy lint: public copy may not affirmatively claim a sync/one-click feature for an integration
// that is not `available`. A line is a violation when it names the integration, uses an
// affirmative claim phrase, and contains no hedge such as "planned" or "coming soon".
// ---------------------------------------------------------------------------------------------

const CLAIM = /\b(syncs?|synced|syncing|pushes|pushed|one-click|one click|automatically (?:sync|push|update)|integrates with|seamless(?:ly)?)\b/i
const HEDGE = /\b(planned|coming soon|not available|not built|not yet|roadmap|future|will|would|later|if still wanted|decision)\b/i

export function copyViolations(text: string, names: string[]): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!CLAIM.test(line) || HEDGE.test(line)) continue
    const lower = line.toLowerCase()
    for (const name of names) if (lower.includes(name.toLowerCase())) out.push(`${name}: ${line.trim()}`)
  }
  return out
}

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, accept, out)
    else if (accept(full)) out.push(full)
  }
  return out
}

describe('copy lint', () => {
  const names = INTEGRATIONS.filter((i) => i.status !== 'available').map((i) => i.name)

  it('flags an affirmative claim and accepts a hedged one (self-test)', () => {
    expect(copyViolations('HushVault syncs secrets to Cloudflare Pages in one click.', names)).toHaveLength(1)
    expect(copyViolations('Cloudflare Pages sync is planned and not available yet.', names)).toEqual([])
    expect(copyViolations('Inject secrets into any command with the CLI.', names)).toEqual([])
  })

  it('README and web copy do not claim non-available integrations work', () => {
    const files = [
      join(ROOT, 'README.md'),
      ...walk(join(ROOT, 'apps/web/src'), (f) => /\.(tsx?|md)$/.test(f)),
    ]
    const bad = files.flatMap((f) => copyViolations(readFileSync(f, 'utf8'), names).map((v) => `${relative(ROOT, f)} -> ${v}`))
    expect(bad).toEqual([])
  })
})
