import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSessionStore } from '../src/client/session-store'

type S = { token: string; userId: string }
const session = (n: string): S => ({ token: `t-${n}`, userId: `u-${n}` })

afterEach(() => vi.unstubAllGlobals())

describe('session store', () => {
  it('holds the session in memory and tells subscribers about every change', () => {
    const store = createSessionStore<S>({ hintKey: 'k' })
    const seen: (string | null)[] = []
    const off = store.subscribe(() => seen.push(store.read()?.token ?? null))
    store.write(session('a'))
    store.write(session('b'))
    store.clear()
    off()
    store.write(session('c'))
    expect(seen).toEqual(['t-a', 't-b', null])
    expect(store.read()?.token).toBe('t-c')
  })

  it('clearing an already-empty store does not notify', () => {
    const store = createSessionStore<S>({ hintKey: 'k' })
    const listener = vi.fn()
    store.subscribe(listener)
    store.clear()
    expect(listener).not.toHaveBeenCalled()
  })

  it('two stores never share state or a hint key', () => {
    const a = createSessionStore<S>({ hintKey: 'a' })
    const b = createSessionStore<S>({ hintKey: 'b' })
    a.write(session('1'))
    expect(b.read()).toBeNull()
    expect(a.hintKey).not.toBe(b.hintKey)
  })

  it('a listener that unsubscribes while being notified does not break delivery to the others', () => {
    const store = createSessionStore<S>({ hintKey: 'k' })
    const calls: string[] = []
    const offFirst = store.subscribe(() => { calls.push('first'); offFirst() })
    store.subscribe(() => calls.push('second'))
    store.write(session('a'))
    store.write(session('b'))
    expect(calls).toEqual(['first', 'second', 'second'])
  })
})

describe('session hint', () => {
  function fakeStorage() {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) },
    }
  }

  it('stores only a boolean under its own key', () => {
    const storage = fakeStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const store = createSessionStore<S>({ hintKey: 'hv_test' })
    expect(store.hasHint()).toBe(false)
    store.markHint(true)
    expect([...storage.data.entries()]).toEqual([['hv_test', '1']])
    expect(store.hasHint()).toBe(true)
    store.markHint(false)
    expect(storage.data.size).toBe(0)
  })

  it('never persists the token or the session', () => {
    const storage = fakeStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const store = createSessionStore<S>({ hintKey: 'hv_test' })
    store.write(session('secret'))
    store.markHint(true)
    expect(JSON.stringify([...storage.data.entries()])).not.toContain('secret')
  })

  it('says "try the refresh" when storage is unreadable, and tolerates unwritable storage', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    vi.stubGlobal('window', { localStorage: blocked })
    const store = createSessionStore<S>({ hintKey: 'k' })
    expect(store.hasHint()).toBe(true)
    expect(() => store.markHint(true)).not.toThrow()
    expect(() => store.markHint(false)).not.toThrow()
  })

  it('has no hint and no error outside a browser', () => {
    const store = createSessionStore<S>({ hintKey: 'k' })
    expect(store.hasHint()).toBe(false)
    expect(() => store.markHint(true)).not.toThrow()
  })
})

// The access token must never reach script-readable storage, and the one boolean hint is the only
// thing allowed there. Asserted from source so a new file cannot quietly start persisting state.
describe('browser storage invariant', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url))
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return files(full)
      return /\.(ts|tsx)$/.test(e.name) ? [full] : []
    })

  it('only session-store.ts touches localStorage or sessionStorage', () => {
    const offenders = files(SRC)
      .filter((f) => /localStorage|sessionStorage/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))
    expect(offenders).toEqual(['client/session-store.ts'])
  })

  it('never writes anything but the literal hint value', () => {
    const source = readFileSync(join(SRC, 'client', 'session-store.ts'), 'utf8')
    const writes = [...source.matchAll(/setItem\(([^)]*)\)/g)].map((m) => m[1])
    expect(writes).toEqual(["hintKey, '1'"])
  })
})
