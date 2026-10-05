// Bulk KV reads and blob-key parsing (issue #87).
import { describe, expect, it } from 'vitest'
import {
  KV_BULK_READ_MAX,
  KV_READ_CONCURRENCY,
  allSecretBlobKeys,
  parseSecretBlobKey,
  readSecretBlobs,
  secretBlobKey,
} from '../src/lib/secret-blobs'

type Call = { kind: 'bulk'; keys: string[] } | { kind: 'single'; key: string }

/** A KV double that implements Cloudflare's bulk read: get(keys) -> Map. */
class BulkKV {
  readonly store = new Map<string, string>()
  readonly calls: Call[] = []
  constructor(entries: Iterable<[string, string]> = []) {
    for (const [k, v] of entries) this.store.set(k, v)
  }
  async get(key: string | string[], _type?: string): Promise<string | null | Map<string, string | null>> {
    if (Array.isArray(key)) {
      this.calls.push({ kind: 'bulk', keys: key })
      if (key.length > KV_BULK_READ_MAX) throw new Error('too many keys')
      return new Map(key.map((k) => [k, this.store.get(k) ?? null]))
    }
    this.calls.push({ kind: 'single', key })
    return this.store.get(key) ?? null
  }
}

/** A binding from before bulk reads: the array is coerced to a key and misses. */
class SingleOnlyKV {
  readonly store = new Map<string, string>()
  readonly calls: Call[] = []
  constructor(entries: Iterable<[string, string]> = []) {
    for (const [k, v] of entries) this.store.set(k, v)
  }
  async get(key: string | string[]): Promise<string | null> {
    if (Array.isArray(key)) {
      this.calls.push({ kind: 'bulk', keys: key })
      return null
    }
    this.calls.push({ kind: 'single', key })
    return this.store.get(key) ?? null
  }
}

/** A binding that rejects the array form outright. */
class ThrowingBulkKV extends SingleOnlyKV {
  override async get(key: string | string[]): Promise<string | null> {
    if (Array.isArray(key)) {
      this.calls.push({ kind: 'bulk', keys: key })
      throw new TypeError('get() takes a string')
    }
    return super.get(key)
  }
}

const entries = (n: number): [string, string][] =>
  Array.from({ length: n }, (_, i) => [`secret:sec_${i}:1`, `blob-${i}`])

describe('readSecretBlobs', () => {
  it('uses one bulk call per chunk of the documented maximum, never more keys than that', async () => {
    const all = entries(250)
    const kv = new BulkKV(all)
    const got = await readSecretBlobs(kv as never, all.map(([k]) => k))

    expect(got.size).toBe(250)
    expect(got.get('secret:sec_0:1')).toBe('blob-0')
    expect(got.get('secret:sec_249:1')).toBe('blob-249')
    // 250 keys at 100 per call: three calls, not 250 operations.
    expect(kv.calls).toHaveLength(3)
    expect(kv.calls.map((c) => (c.kind === 'bulk' ? c.keys.length : -1))).toEqual([100, 100, 50])
    expect(kv.calls.every((c) => c.kind === 'bulk' && c.keys.length <= KV_BULK_READ_MAX)).toBe(true)
  })

  it('reports a missing key as null rather than omitting it', async () => {
    const kv = new BulkKV([['secret:sec_a:1', 'A']])
    const got = await readSecretBlobs(kv as never, ['secret:sec_a:1', 'secret:sec_gone:4'])
    expect(got.get('secret:sec_a:1')).toBe('A')
    expect(got.has('secret:sec_gone:4')).toBe(true)
    expect(got.get('secret:sec_gone:4')).toBeNull()
  })

  it('reads nothing at all for an empty key list', async () => {
    const kv = new BulkKV()
    expect((await readSecretBlobs(kv as never, [])).size).toBe(0)
    expect(kv.calls).toHaveLength(0)
  })

  it('falls back to bounded single reads when the binding answers the array form with a non-Map', async () => {
    const all = entries(15)
    const kv = new SingleOnlyKV(all)
    const got = await readSecretBlobs(kv as never, all.map(([k]) => k))

    expect(got.size).toBe(15)
    expect([...got.values()]).toEqual(all.map(([, v]) => v))
    // One rejected probe, then every key read singly.
    expect(kv.calls.filter((c) => c.kind === 'bulk')).toHaveLength(1)
    expect(kv.calls.filter((c) => c.kind === 'single')).toHaveLength(15)
  })

  it('falls back when the binding throws on the array form', async () => {
    const all = entries(4)
    const kv = new ThrowingBulkKV(all)
    const got = await readSecretBlobs(kv as never, all.map(([k]) => k))
    expect([...got.values()]).toEqual(all.map(([, v]) => v))
    expect(kv.calls.filter((c) => c.kind === 'single')).toHaveLength(4)
  })

  it('probes a non-bulk binding only once, however many times it is used', async () => {
    const all = entries(3)
    const kv = new SingleOnlyKV(all)
    const keys = all.map(([k]) => k)
    await readSecretBlobs(kv as never, keys)
    await readSecretBlobs(kv as never, keys)
    await readSecretBlobs(kv as never, keys)
    expect(kv.calls.filter((c) => c.kind === 'bulk')).toHaveLength(1)
  })

  it('keeps the fallback fan-out within the simultaneous-connection budget', async () => {
    // Each batch must settle before the next starts, so no more than KV_READ_CONCURRENCY
    // reads are ever outstanding.
    let inFlight = 0
    let peak = 0
    const kv = {
      async get(key: string | string[]) {
        if (Array.isArray(key)) return null
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        return `v-${key}`
      },
    }
    await readSecretBlobs(kv as never, entries(40).map(([k]) => k))
    expect(peak).toBeLessThanOrEqual(KV_READ_CONCURRENCY)
  })
})

describe('parseSecretBlobKey', () => {
  it('round-trips every key secretBlobKey can write', () => {
    for (const rev of [0, 1, 2, 97]) {
      const key = secretBlobKey('sec_abc', rev)
      expect(parseSecretBlobKey(key)).toEqual({ key, secretId: 'sec_abc', rev })
    }
    for (const key of allSecretBlobKeys('sec_xyz', 3)) {
      expect(parseSecretBlobKey(key)?.secretId).toBe('sec_xyz')
    }
  })

  it('refuses anything that is not one of those two shapes', () => {
    for (const key of [
      'secrethist:sech_1', // pre-0014 history copies live outside the secret: prefix (issue #84)
      'jwks:https://example.test',
      'ghss:public-keys',
      'secret:', // no id
      'secret::1', // empty id
      'secret:sec_a:', // empty revision
      'secret:sec_a:0', // revision 0 is written unversioned, never as :0
      'secret:sec_a:01', // leading zero
      'secret:sec_a:-1',
      'secret:sec_a:1x',
      'secret:sec_a:1:2', // too many segments
      'notsecret:sec_a',
    ]) {
      expect(parseSecretBlobKey(key)).toBeNull()
    }
  })
})
