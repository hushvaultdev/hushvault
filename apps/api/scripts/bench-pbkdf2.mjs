#!/usr/bin/env node
/**
 * PBKDF2-HMAC-SHA256 cost measurement — harness for GitHub issue #89.
 *
 * Measures `crypto.subtle.deriveBits` (PBKDF2-SHA256, 256-bit output, 16-byte
 * salt — the same shape as `hashPassword` in apps/api/src/lib/auth.ts) at a
 * range of iteration counts, and reports the median over several runs.
 *
 * Two environments:
 *   workers  `wrangler dev` (workerd), the runtime the API actually runs on.
 *            The benchmark Worker is `pbkdf2-bench.worker.js`, started with
 *            `pbkdf2-bench.wrangler.toml`. Local workerd, not the edge: no
 *            CPU accounting, and the machine is this container.
 *   node     bare Node.js (node:crypto webcrypto) in this process. Useful as a
 *            cross-check; NOT a Workers number.
 *
 * Nothing is deployed and no Cloudflare API call is made.
 *
 * Usage (from apps/api/):
 *   node scripts/bench-pbkdf2.mjs                      # both environments
 *   node scripts/bench-pbkdf2.mjs --env=workers
 *   node scripts/bench-pbkdf2.mjs --env=node
 *   node scripts/bench-pbkdf2.mjs --runs=9 --reps=5
 *   node scripts/bench-pbkdf2.mjs --iterations=100000,600000
 *   node scripts/bench-pbkdf2.mjs --json
 *
 * Safety: inputs are throwaway random bytes generated per measurement. The
 * harness prints timings only — never a password, salt or derived key.
 */

import { spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const API_DIR = resolve(SCRIPT_DIR, '..')

const DEFAULTS = {
  iterations: [100_000, 300_000, 600_000, 1_000_000],
  runs: 7,
  reps: 3,
  warmup: 1,
  env: 'both',
  port: 8799,
  json: false,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (const arg of argv) {
    const [rawKey, rawValue] = arg.replace(/^--/, '').split('=')
    switch (rawKey) {
      case 'iterations':
        options.iterations = rawValue.split(',').map((value) => Number(value.trim()))
        break
      case 'runs':
      case 'reps':
      case 'warmup':
      case 'port':
        options[rawKey] = Number(rawValue)
        break
      case 'env':
        options.env = rawValue
        break
      case 'json':
        options.json = true
        break
      case 'help':
        console.log('See the header comment of scripts/bench-pbkdf2.mjs for usage.')
        process.exit(0)
        break
      default:
        throw new Error(`Unknown option: --${rawKey}`)
    }
  }
  if (!['both', 'node', 'workers'].includes(options.env)) {
    throw new Error(`--env must be one of both|node|workers (got ${options.env})`)
  }
  if (options.iterations.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('--iterations must be a comma-separated list of positive integers')
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs must be >= 1')
  if (!Number.isInteger(options.reps) || options.reps < 1) throw new Error('--reps must be >= 1')
  return options
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

const round = (value) => Math.round(value * 100) / 100

function summarise(samples) {
  return {
    samples: samples.length,
    medianMs: round(median(samples)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
  }
}

// ---------------------------------------------------------------- node ------

async function deriveInNode(iterations) {
  const password = webcrypto.getRandomValues(new Uint8Array(24))
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const baseKey = await webcrypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
  const started = performance.now()
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    256,
  )
  const elapsed = performance.now() - started
  if (bits.byteLength !== 32) throw new Error('unexpected derived length')
  return elapsed
}

async function benchNode(options) {
  const results = []
  for (const iterations of options.iterations) {
    for (let i = 0; i < options.warmup; i += 1) await deriveInNode(iterations)
    const samples = []
    for (let run = 0; run < options.runs; run += 1) {
      const perRep = []
      for (let rep = 0; rep < options.reps; rep += 1) perRep.push(await deriveInNode(iterations))
      samples.push(median(perRep))
    }
    results.push({ environment: 'node', iterations, ...summarise(samples) })
    process.stderr.write(`  node   ${iterations.toLocaleString()} it -> ${results.at(-1).medianMs} ms\n`)
  }
  return results
}

// -------------------------------------------------------------- workers -----

function resolveWranglerBin() {
  // Prefer the version pinned in apps/api/package.json over whatever npx finds.
  const require = createRequire(resolve(API_DIR, 'package.json'))
  try {
    return require.resolve('wrangler/bin/wrangler.js')
  } catch {
    return null
  }
}

async function startWranglerDev(options) {
  const wranglerBin = resolveWranglerBin()
  if (!wranglerBin) {
    throw new Error('wrangler is not installed in apps/api — run `pnpm install` first')
  }
  const child = spawn(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--config',
      resolve(SCRIPT_DIR, 'pbkdf2-bench.wrangler.toml'),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(options.port),
      '--inspector-port',
      String(options.port + 1),
      '--log-level',
      'warn',
    ],
    {
      cwd: SCRIPT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        WRANGLER_SEND_METRICS: 'false',
      },
    },
  )

  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))

  const base = `http://127.0.0.1:${options.port}`
  const deadline = Date.now() + 90_000
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited (code ${child.exitCode}):\n${log.join('')}`)
    }
    try {
      const response = await fetch(`${base}/?iterations=1000&reps=1`)
      if (response.ok) {
        await response.json()
        return { child, base }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill('SIGTERM')
  throw new Error(`wrangler dev did not become ready (${lastError}):\n${log.join('')}`)
}

async function timeRequest(base, iterations, reps) {
  const started = performance.now()
  const response = await fetch(`${base}/?iterations=${iterations}&reps=${reps}`)
  const body = await response.json()
  const elapsed = performance.now() - started
  if (!response.ok) throw new Error(`benchmark Worker returned ${response.status}: ${body.error}`)
  return { elapsed, body }
}

async function benchWorkers(options) {
  process.stderr.write('  starting wrangler dev (workerd, local)...\n')
  const { child, base } = await startWranglerDev(options)
  try {
    // Request overhead baseline: one derivation at the cheapest possible cost,
    // so it can be subtracted from the measured requests.
    const overheadSamples = []
    for (let run = 0; run < Math.max(options.runs, 5); run += 1) {
      const { elapsed } = await timeRequest(base, 1, 1)
      overheadSamples.push(elapsed)
    }
    const overheadMs = median(overheadSamples)
    process.stderr.write(`  request overhead (median, 1 iteration): ${round(overheadMs)} ms\n`)

    const results = []
    for (const iterations of options.iterations) {
      for (let i = 0; i < options.warmup; i += 1) await timeRequest(base, iterations, options.reps)
      const samples = []
      const insideDate = []
      const insidePerf = []
      for (let run = 0; run < options.runs; run += 1) {
        const { elapsed, body } = await timeRequest(base, iterations, options.reps)
        samples.push(Math.max(elapsed - overheadMs, 0) / options.reps)
        insideDate.push(body.insideDateMs / options.reps)
        if (typeof body.insidePerfMs === 'number') insidePerf.push(body.insidePerfMs / options.reps)
      }
      results.push({
        environment: 'workerd-local',
        iterations,
        ...summarise(samples),
        insideWorkerDateNowMedianMs: round(median(insideDate)),
        insideWorkerPerformanceNowMedianMs: insidePerf.length ? round(median(insidePerf)) : null,
        overheadSubtractedMs: round(overheadMs),
      })
      process.stderr.write(
        `  workerd ${iterations.toLocaleString()} it -> ${results.at(-1).medianMs} ms` +
          ` (in-Worker performance.now(): ${results.at(-1).insideWorkerPerformanceNowMedianMs} ms,` +
          ` Date.now(): ${results.at(-1).insideWorkerDateNowMedianMs} ms)\n`,
      )
    }
    return results
  } finally {
    child.kill('SIGTERM')
  }
}

// ----------------------------------------------------------------- main -----

function printTable(results) {
  const header = ['environment', 'iterations', 'median ms', 'min ms', 'max ms', 'runs']
  const rows = results.map((r) => [
    r.environment,
    r.iterations.toLocaleString(),
    String(r.medianMs),
    String(r.minMs),
    String(r.maxMs),
    String(r.samples),
  ])
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  )
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  console.log(line(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(
    `PBKDF2-HMAC-SHA256, 256-bit output, 16-byte salt\n` +
      `runs=${options.runs} reps=${options.reps} warmup=${options.warmup}` +
      ` iterations=${options.iterations.join(',')}\n` +
      `host: node ${process.version} on ${process.platform}/${process.arch}\n`,
  )

  const results = []
  if (options.env === 'workers' || options.env === 'both') {
    results.push(...(await benchWorkers(options)))
  }
  if (options.env === 'node' || options.env === 'both') {
    results.push(...(await benchNode(options)))
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          host: { node: process.version, platform: process.platform, arch: process.arch },
          options,
          results,
        },
        null,
        2,
      ),
    )
  } else {
    console.log('')
    printTable(results)
    console.log('')
    console.log('workerd-local = `wrangler dev` on this machine, NOT a deployed Worker:')
    console.log('wall clock measured from outside the Worker, request overhead subtracted.')
    console.log('node = bare Node.js webcrypto in-process. Not a Workers number.')
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
