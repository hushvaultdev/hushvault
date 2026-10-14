export type BadgeTone = 'accent' | 'neutral' | 'success' | 'warning' | 'danger'

/** Visual weight of a plan: free is quiet, anything paid or comped stands out. */
export function planTone(plan: string): BadgeTone {
  if (plan === 'free') return 'neutral'
  if (plan === 'enterprise') return 'accent'
  return 'success'
}

/** "-" for a plan with no expiry, otherwise the date plus how long is left (or that it has lapsed). */
export function formatExpiry(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '-'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '-'
  const days = Math.ceil((at - now) / 86_400_000)
  const date = new Date(at).toLocaleDateString()
  if (days < 0) return `${date} (expired)`
  if (days === 0) return `${date} (today)`
  return `${date} (${days}d left)`
}

/** A limit of -1 means unlimited everywhere in the API. */
export function formatLimit(n: number): string {
  return n < 0 ? 'Unlimited' : String(n)
}
