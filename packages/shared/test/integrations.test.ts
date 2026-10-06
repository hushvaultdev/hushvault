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
//
// A `beta` integration is a third case, and lumping it in with `planned` was wrong: Cloudflare
// Workers sync is BUILT and shipped (it passes the promotion gate above -- provider module, test
// and docs page all exist), so "Cloudflare Workers secrets sync (beta)" is an honest sentence and
// the lint used to reject it. The rule is now: a beta integration may be named in a claim only if
// the same line LABELS it beta. A planned one still may not be named at all -- and calling a
// planned integration "beta" is exactly the lie this lint exists to catch, so the label only
// excuses the integrations that really are in beta.
// ---------------------------------------------------------------------------------------------

const CLAIM = /\b(syncs?|synced|syncing|pushes|pushed|one-click|one click|automatically (?:sync|push|update)|integrates with|seamless(?:ly)?)\b/i
const HEDGE = /\b(planned|coming soon|not available|not built|not yet|roadmap|future|will|would|later|if still wanted|decision)\b/i
/** An explicit pre-release label. Only excuses a claim for an integration whose status IS beta. */
const BETA_LABEL = /\b(beta|preview|early access)\b/i

export function copyViolations(text: string, names: string[], betaNames: string[] = []): string[] {
  const beta = new Set(betaNames.map((n) => n.toLowerCase()))
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!CLAIM.test(line) || HEDGE.test(line)) continue
    const lower = line.toLowerCase()
    for (const name of names) {
      if (!lower.includes(name.toLowerCase())) continue
      if (beta.has(name.toLowerCase()) && BETA_LABEL.test(line)) continue
      out.push(`${name}: ${line.trim()}`)
    }
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
  const betaNames = INTEGRATIONS.filter((i) => i.status === 'beta').map((i) => i.name)

  it('flags an affirmative claim and accepts a hedged one (self-test)', () => {
    expect(copyViolations('HushVault syncs secrets to Cloudflare Pages in one click.', names)).toHaveLength(1)
    expect(copyViolations('Cloudflare Pages sync is planned and not available yet.', names)).toEqual([])
    expect(copyViolations('Inject secrets into any command with the CLI.', names)).toEqual([])
  })

  it('a beta integration may be claimed only when the line says beta (self-test)', () => {
    expect(copyViolations('Cloudflare Workers secrets sync (beta)', names, betaNames)).toEqual([])
    // Same sentence without the label is still a violation: the reader cannot tell it is beta.
    expect(copyViolations('Cloudflare Workers secrets sync', names, betaNames)).toHaveLength(1)
    // And the label does not launder a PLANNED integration into a shipped one.
    expect(copyViolations('Cloudflare Pages secrets sync (beta)', names, betaNames)).toHaveLength(1)
    // The excuse is per integration, not per line: a line naming both is still caught for Pages.
    expect(copyViolations('Sync to Cloudflare Workers and Cloudflare Pages (beta)', names, betaNames)).toEqual([
      'Cloudflare Pages: Sync to Cloudflare Workers and Cloudflare Pages (beta)',
    ])
  })

  it('README, docs/INTEGRATIONS.md and web copy (including the FAQ) do not claim non-available integrations work', () => {
    const files = [
      join(ROOT, 'README.md'),
      join(ROOT, 'docs/INTEGRATIONS.md'),
      ...walk(join(ROOT, 'apps/web/src'), (f) => /\.(tsx?|md)$/.test(f)),
    ]
    const bad = files.flatMap((f) => copyViolations(readFileSync(f, 'utf8'), names, betaNames).map((v) => `${relative(ROOT, f)} -> ${v}`))
    expect(bad).toEqual([])
  })
})
