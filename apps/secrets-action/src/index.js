// HushVault secrets action (issue #43).
//
// Flow: ask GitHub for an OIDC token -> exchange it at HushVault for a short-lived, read-only token scoped to one
// environment -> read that environment -> mask every value and export it.
//
// Rules this file follows, because a mistake here leaks secrets into a public build log:
//  - A value is masked with ::add-mask:: BEFORE it can reach any other output, and masks are flushed line by line.
//  - Values are never printed, never put in an output, and never written to a file other than $GITHUB_ENV.
//  - No HushVault token is ever stored in the repository: the only credential is the OIDC token GitHub mints.
//  - A secret NAME is never exported if it could change how the job runs (see UNSAFE_NAMES): writing LD_PRELOAD or
//    PATH into $GITHUB_ENV is arbitrary code execution on the runner, so whoever can add a secret must not be able
//    to reach it. Creating a secret only needs the `member` role, which is far below the admin who grants CI access.
//  - No third-party dependencies, so nothing else in the dependency tree can read the values.
'use strict'

const fs = require('node:fs')

/**
 * Names that must never be written to $GITHUB_ENV. These change how later steps execute (loader, lookup path,
 * interpreter flags) or impersonate the runner's own credentials. A deny list is paired with a strict name shape, so
 * anything unusual is refused rather than exported.
 */
const UNSAFE_NAMES = /^(PATH|HOME|IFS|CI|SHELL|SHELLOPTS|BASH_ENV|ENV|PS4|PERL5OPT|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|GIT_.*|GITHUB_.*|RUNNER_.*|ACTIONS_.*|INPUT_.*)$/
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/

function exportableName(name) {
  return NAME_SHAPE.test(name) && !UNSAFE_NAMES.test(name)
}

function input(name, fallback = '') {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]
  return value === undefined || value === '' ? fallback : value
}

/** Workflow commands are line-based: a value containing a newline must be masked one line at a time. */
function mask(value) {
  for (const line of String(value).split(/\r?\n/)) {
    if (line.length > 0) process.stdout.write(`::add-mask::${line}\n`)
  }
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`)
  process.exit(1)
}

function appendFileCommand(file, name, value) {
  // Heredoc form so multi-line values survive. The delimiter is random, so a value cannot close it early.
  const delimiter = `HV_${require('node:crypto').randomBytes(16).toString('hex')}`
  if (String(value).includes(delimiter)) fail('Could not export a secret safely')
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

async function requestOidcToken(audience) {
  const url = process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
  const token = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
  if (!url || !token) {
    fail('No OIDC token available. Add "permissions: id-token: write" to the job.')
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json; api-version=2.0' },
  })
  if (!res.ok) fail(`Could not get an OIDC token from GitHub (HTTP ${res.status}).`)
  const body = await res.json()
  if (!body || typeof body.value !== 'string') fail('GitHub returned an unexpected OIDC response.')
  return body.value
}

async function hushvault(apiUrl, path, init) {
  const res = await fetch(`${apiUrl}${path}`, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function main() {
  const apiUrl = input('api-url', 'https://api.hushvault.dev').replace(/\/+$/, '')
  const environmentId = input('environment-id')
  const audience = input('audience', 'https://api.hushvault.dev')
  const exportEnv = input('export-env', 'true') !== 'false'
  const prefix = input('prefix', '')
  if (!environmentId) fail('environment-id is required.')
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiUrl)) {
    fail('api-url must use https.')
  }
  if (prefix && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) fail('prefix must be a valid environment-variable prefix.')

  // L5: a changed api-url must not be able to send a token minted for the real API somewhere else. The audience
  // follows api-url unless both were set deliberately and agree.
  if (new URL(audience).host !== new URL(apiUrl).host) {
    fail('audience must match api-url: a token minted for one host must never be sent to another.')
  }

  const oidcToken = await requestOidcToken(audience)
  const exchange = await hushvault(apiUrl, '/api/auth/github-oidc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: oidcToken, envId: environmentId }),
  })
  if (exchange.status !== 200 || !exchange.body || !exchange.body.data || !exchange.body.data.token) {
    const message = exchange.body && exchange.body.message ? exchange.body.message : `HTTP ${exchange.status}`
    fail(`HushVault refused the OIDC exchange: ${message}`)
  }
  const ciToken = exchange.body.data.token
  mask(ciToken)

  const read = await hushvault(apiUrl, `/api/environments/${encodeURIComponent(environmentId)}/resolved?values=true`, {
    headers: { authorization: `Bearer ${ciToken}`, accept: 'application/json' },
  })
  if (read.status !== 200 || !read.body || !read.body.data || !Array.isArray(read.body.data.secrets)) {
    const message = read.body && read.body.message ? read.body.message : `HTTP ${read.status}`
    fail(`Could not read the environment: ${message}`)
  }

  const names = []
  for (const secret of read.body.data.secrets) {
    if (!secret || typeof secret.name !== 'string' || typeof secret.value !== 'string') continue
    // Mask first, always, before the value can reach anything else.
    mask(secret.value)
    names.push(secret.name)
  }
  if (exportEnv) {
    const file = process.env['GITHUB_ENV']
    if (!file) fail('GITHUB_ENV is not set; cannot export secrets.')
    // Refuse loudly rather than skipping quietly: a silently missing variable is debugged for an hour, and a
    // deliberately planted one is exactly what an operator needs to be told about.
    const unsafe = names.filter((name) => !exportableName(`${prefix}${name}`))
    if (unsafe.length > 0) {
      fail(`Refusing to export ${unsafe.join(', ')}: that name would change how this job runs. Rename the secret in HushVault, or set the action's "prefix" input.`)
    }
    for (const secret of read.body.data.secrets) {
      if (!secret || typeof secret.name !== 'string' || typeof secret.value !== 'string') continue
      appendFileCommand(file, `${prefix}${secret.name}`, secret.value)
    }
  }
  const output = process.env['GITHUB_OUTPUT']
  if (output) fs.appendFileSync(output, `names=${JSON.stringify(names)}\n`)
  process.stdout.write(`Loaded ${names.length} secret${names.length === 1 ? '' : 's'} from HushVault.\n`)
}

if (require.main === module) {
  main().catch((err) => fail(`Unexpected failure: ${err && err.message ? err.message : 'unknown error'}`))
}

module.exports = { mask, appendFileCommand, exportableName, main }
