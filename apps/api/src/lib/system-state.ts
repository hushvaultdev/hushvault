// A tiny keyed scratchpad for the cron's own bookkeeping (issue #87, migration 0016).
//
// Nothing secret is ever stored here: only timestamps, opaque error codes and a KV list
// cursor. Never a key, a DEK, a wrapped DEK, a secret id's value or any ciphertext.
//
// Every call swallows its errors and reports "no state". The cron shares one invocation
// with key rotation and the sync tick and must keep working on a deployment whose
// migrations have not caught up yet, and nothing here is load-bearing for correctness:
// losing a row costs a repeated scan or a restarted grace period, never a wrong answer.
import type { Env } from '../index'

export type SystemState = { value: string; updatedAt: string }

export async function readSystemState(env: Env, key: string): Promise<SystemState | null> {
  try {
    const row = await env.DB.prepare('SELECT value, updated_at FROM system_state WHERE key = ? LIMIT 1')
      .bind(key).first<{ value: string; updated_at: string }>()
    return row ? { value: row.value, updatedAt: row.updated_at } : null
  } catch {
    return null
  }
}

export async function writeSystemState(env: Env, key: string, value: string, nowIso: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(key, value, nowIso).run()
  } catch {
    // Nothing to report: a lost write only means the work is repeated next tick.
  }
}

export async function clearSystemState(env: Env, key: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM system_state WHERE key = ?').bind(key).run()
  } catch {
    // As above.
  }
}
