#!/usr/bin/env node
// Migration-drift gate (issue #119). Fails loud when the deployed D1 is missing migrations the
// code references. Run before a deploy: `node scripts/check-migrations.mjs <env>` where env is
// `dev` or `production`.
//
// Why this exists: Workers Builds runs `wrangler deploy` but NOT `wrangler d1 migrations apply`.
// Twice in one session (2026-10-19) the deployed code referenced a column the live D1 did not
// have (migration 0022), and register returned 500 for everyone. This script turns that silent
// drift into a non-zero exit before the deploy ships.
//
// Auth: reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment and queries the
// D1 REST API directly (SELECT COUNT(*) FROM d1_migrations). Needs only D1 *read* — the same
// scope the e2e lane uses. The per-env database id is parsed from wrangler.toml so there is one
// source of truth.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const env = process.argv[2]
if (env !== 'dev' && env !== 'production') {
  console.error('Usage: node scripts/check-migrations.mjs <dev|production>')
  process.exit(2)
}

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
if (!token || !accountId) {
  console.error('check-migrations: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const apiDir = resolve(here, '..')
const migrationsDir = resolve(apiDir, 'migrations')
const localCount = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length

// Parse the database_id from the [[env.<env>.d1_databases]] block in wrangler.toml.
const toml = readFileSync(resolve(apiDir, 'wrangler.toml'), 'utf8')
const section = toml.indexOf(`[[env.${env}.d1_databases]]`)
if (section === -1) {
  console.error(`check-migrations: no [[env.${env}.d1_databases]] block in wrangler.toml.`)
  process.exit(2)
}
const idMatch = /database_id\s*=\s*"([^"]+)"/.exec(toml.slice(section))
if (!idMatch) {
  console.error(`check-migrations: no database_id under [[env.${env}.d1_databases]].`)
  process.exit(2)
}
const databaseId = idMatch[1]

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM d1_migrations' }),
  },
)
const body = await res.json().catch(() => null)
if (!res.ok || !body?.success) {
  console.error(`check-migrations: D1 query failed (HTTP ${res.status}).`)
  console.error(JSON.stringify(body?.errors ?? body, null, 2))
  process.exit(2)
}

const remoteCount = body.result?.[0]?.results?.[0]?.n ?? -1
if (remoteCount === localCount) {
  console.log(`check-migrations: OK — ${localCount} local migrations, ${remoteCount} applied on ${env}.`)
  process.exit(0)
}

console.error(
  `check-migrations: DRIFT on ${env} — ${localCount} local migration file(s), ${remoteCount} applied.`,
)
console.error(`Apply the missing migration(s) BEFORE deploying:\n  pnpm --filter @hushvault/api db:migrate:${env}`)
process.exit(1)
