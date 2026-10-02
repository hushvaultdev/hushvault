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

const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names known to change how a later step executes — loaders, lookup paths, interpreter and build-tool flags,
 * package sources, proxies — or to impersonate the runner's own credentials.
 *
 * This list is a BACKSTOP, not the security boundary. "Variables that change how a process runs" is an open-ended
 * set (every language runtime and build tool adds its own), and a list can only ever chase it. The actual boundary
 * is `prefix` or `names`: both put the workflow author — who already controls what the job runs — in charge of which
 * variables appear, instead of whoever can add a secret. Matching is case-insensitive because runner environments
 * on Windows are, and because `path` is read by plenty of tooling on Linux too.
 */
const UNSAFE_NAMES = /^(PATH|HOME|IFS|CI|SHELL|SHELLOPTS|BASH_ENV|ENV|PS4|PROMPT_COMMAND|EDITOR|VISUAL|PAGER|MANPAGER|LESSOPEN|TERMINFO|TMPDIR|LD_.*|DYLD_.*|GIT_.*|GITHUB_.*|RUNNER_.*|ACTIONS_.*|INPUT_.*|NODE_.*|NPM_.*|npm_config_.*|YARN_.*|PNPM_.*|PYTHON.*|PIP_.*|VIRTUAL_ENV|CONDA_.*|RUBY.*|GEM_.*|BUNDLE_.*|PERL.*|JAVA_.*|_JAVA_.*|JDK_.*|JRE_.*|CLASSPATH|GRADLE_.*|MAVEN_.*|SBT_.*|GO(FLAGS|PATH|ROOT|PROXY|PRIVATE|BIN|CACHE|MODCACHE|TOOLCHAIN|ENV|INSECURE|SUMDB|NOSUMDB|NOPROXY|DEBUG)|CGO_.*|RUSTFLAGS|RUSTC.*|RUSTUP_.*|CARGO_.*|DOTNET_.*|NUGET_.*|COMPLUS_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_.*|CURL_.*|REQUESTS_CA_BUNDLE|AWS_.*|AZURE_.*|GOOGLE_.*|GCLOUD_.*|CLOUDSDK_.*|DOCKER_.*|KUBE.*|LD|PRELOAD)$/i

/**
 * May this name be written to $GITHUB_ENV? `prefix` is included in the check, so a prefix that itself creates a
 * dangerous name (prefix `LD_` + secret `PRELOAD`) is caught too.
 */
function exportableName(name) {
  return NAME_SHAPE.test(name) && !UNSAFE_NAMES.test(name)
}

/** Parse the optional `names` input: an explicit allowlist chosen by the workflow author. */
function parseNames(raw) {
  return raw.split(/[\s,]+/).map((n) => n.trim()).filter((n) => n.length > 0)
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
  const only = parseNames(input('names', ''))
  for (const name of only) {
    if (!NAME_SHAPE.test(name)) fail(`"names" contains an invalid secret name: ${name}`)
  }
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
    const selected = only.length > 0 ? names.filter((name) => only.includes(name)) : names
    const missing = only.filter((name) => !names.includes(name))
    if (missing.length > 0) fail(`Not found in that environment: ${missing.join(', ')}`)

    // With `names`, the workflow author chose exactly what enters the environment, so the backstop list does not
    // apply — they already control what the job runs. Without it, the list is all that stands between someone who
    // can add a secret and the job's execution, so a hit is a hard failure, not a silent skip.
    if (only.length === 0) {
      const unsafe = selected.filter((name) => !exportableName(`${prefix}${name}`))
      if (unsafe.length > 0) {
        fail(`Refusing to export ${unsafe.join(', ')}: that name could change how this job runs. Set the action's "prefix" input, list the secrets you want in "names", or rename the secret in HushVault.`)
      }
      if (!prefix) {
        process.stdout.write('::warning::Exporting secrets under their own names. Anyone who can add a secret to this environment can then set a variable this job reads. Set "prefix" or "names" to decide that yourself.\n')
      }
    }
    for (const secret of read.body.data.secrets) {
      if (!secret || typeof secret.name !== 'string' || typeof secret.value !== 'string') continue
      if (!selected.includes(secret.name)) continue
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

module.exports = { mask, appendFileCommand, exportableName, parseNames, main }
