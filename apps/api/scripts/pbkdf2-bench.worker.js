/**
 * PBKDF2 benchmark Worker — measurement harness for GitHub issue #89.
 *
 * NOT part of the deployed API, and not part of the test suite. It is loaded
 * only by `bench-pbkdf2.mjs`, which runs it under a local `wrangler dev`
 * (workerd) using its own config (`pbkdf2-bench.wrangler.toml`).
 * Never deploy this.
 *
 * GET /?iterations=<n>&reps=<n>
 *   Derives `reps` PBKDF2-HMAC-SHA256 keys at `iterations` iterations from a
 *   throwaway, locally generated random input and reports timings only. No
 *   password, salt or derived key material is ever returned or logged.
 */

const PASSWORD_BYTES = 24

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const iterations = Number(url.searchParams.get('iterations') ?? '100000')
    const reps = Number(url.searchParams.get('reps') ?? '1')

    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) {
      return Response.json({ error: 'BAD_ITERATIONS' }, { status: 400 })
    }
    if (!Number.isInteger(reps) || reps < 0 || reps > 100) {
      return Response.json({ error: 'BAD_REPS' }, { status: 400 })
    }

    // Throwaway input: random bytes generated here, never persisted or printed.
    const password = crypto.getRandomValues(new Uint8Array(PASSWORD_BYTES))
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const baseKey = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])

    // Clocks inside Workers are deliberately coarse (they advance on I/O), so
    // these two numbers are reported for information only; the runner's own
    // wall-clock measurement from outside is the one that counts.
    const startDate = Date.now()
    const startPerf = typeof performance !== 'undefined' ? performance.now() : null

    let sink = 0
    for (let i = 0; i < reps; i += 1) {
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        baseKey,
        256,
      )
      // Touch one byte so the derivation cannot be optimised away. The value is
      // reduced to a single number mod 251 and nothing else about it escapes.
      sink = (sink + new Uint8Array(bits)[0]) % 251
    }

    const insideDateMs = Date.now() - startDate
    const insidePerfMs = startPerf === null ? null : performance.now() - startPerf

    return Response.json({
      iterations,
      reps,
      insideDateMs,
      insidePerfMs,
      checksumMod251: sink,
    })
  },
}
