// Loads env.local from the repo root and asserts the required e2e vars are present.
// Hard-refuses to run against production. This file is referenced by vitest.e2e.config.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return // optional — users may set vars another way
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([^#=\s][^=]*)=(.*)$/.exec(line)
    if (!m) continue
    const k = m[1]!.trim()
    const v = m[2]!.trim()
    if (!process.env[k]) process.env[k] = v
  }
}

// Repo root is three levels up from apps/api/test/e2e
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
loadEnvFile(resolve(repoRoot, 'env.local'))

const required = [
  'HUSHVAULT_E2E_BASE_URL',
  'HUSHVAULT_E2E_CF_SCRIPT',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
] as const

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`E2E setup: missing env var ${key} (expected in env.local at repo root)`)
  }
}

// Hard refusal: never run this lane against production. The base URL check is intentionally
// coarse — any prod-ish host blocks the whole suite.
const base = process.env.HUSHVAULT_E2E_BASE_URL ?? ''
if (/\/\/api\.hushvault\.dev(?:\/|$)/.test(base) || /\/\/hushvault\.dev(?:\/|$)/.test(base)) {
  throw new Error(`E2E setup: refusing to run against production (${base})`)
}
if (!/^https:\/\//.test(base)) {
  throw new Error(`E2E setup: HUSHVAULT_E2E_BASE_URL must start with https:// (got ${base})`)
}
