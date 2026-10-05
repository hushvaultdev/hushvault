import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pathRequiresSession } from '../src/lib/auth-storage'

// Three invariants behind the organisation switcher that no unit test can reach, because they
// live in component wiring rather than in a function. They are cheap to assert from the source
// and expensive to find again by hand: each one, if broken, shows one organisation's name over
// another organisation's data.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

describe('the dashboard subtree is remounted when the organisation changes', () => {
  it('keys its children on the organisation the access token acts in', () => {
    const layout = readFileSync(join(SRC, 'app', '(dashboard)', 'layout.tsx'), 'utf8')
    // Each dashboard page fetches org-scoped data into its own state on mount and there is no
    // query cache to invalidate, so this key IS the invalidation: change the org, every page
    // below unmounts and refetches.
    expect(layout).toMatch(/key=\{session\?\.orgId/)
    expect(layout).toContain('<OrgProvider>')
  })
})

describe('no organisation is ever read from web storage', () => {
  it('keeps localStorage and sessionStorage out of every file but the session hint', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => /localStorage|sessionStorage/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1))
    // auth-storage.ts holds one boolean hint ("this browser had a session") and nothing else.
    // An org id in local storage can be a switch out of date, which is exactly the bug in #82.
    expect(offenders).toEqual(['lib/auth-storage.ts'])
  })
})

describe('every dashboard route spends the refresh request', () => {
  it('is covered by pathRequiresSession, including the new org pages', () => {
    const routes = readdirSync(join(SRC, 'app', '(dashboard)'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('('))
      .map((entry) => `/${entry.name}`)
    expect(routes).toContain('/members')
    expect(routes).toContain('/organisations')
    for (const route of routes) {
      // A dashboard route missing from the list sends anyone with no localStorage hint to
      // /sign-in although their refresh cookie is valid: "it logs me out on every reload".
      expect(pathRequiresSession(route), route).toBe(true)
    }
  })
})
