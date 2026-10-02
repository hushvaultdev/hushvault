'use client'

import { INTEGRATIONS } from '@hushvault/shared/integrations'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { revokeConnection, rotateCredential, type ConnectionDto } from '@/lib/integrations-api'
import { useFocusReturn } from '@/lib/use-focus-return'
import { describeApiError, formatWhen, validateCredential } from '@/lib/integrations-helpers'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

function providerName(id: string): string {
  return INTEGRATIONS.find((i) => i.id === id)?.name ?? id
}

function ConnectionRow({
  connection,
  onChanged,
  onRevoked,
}: {
  connection: ConnectionDto
  onChanged: (connection: ConnectionDto) => void
  onRevoked: (id: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'rotate' | 'revoke'>('idle')
  const [credential, setCredential] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revokeRef = useFocusReturn<HTMLDivElement>(mode === 'revoke')

  async function rotate(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem = validateCredential(credential)
    if (problem) {
      setError(problem)
      return
    }
    const secret = credential
    setCredential('')
    setBusy(true)
    setError(null)
    try {
      onChanged(await rotateCredential(connection.id, secret))
      setMode('idle')
    } catch (err) {
      setError(describeApiError(err, 'Could not rotate the credential.'))
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      await revokeConnection(connection.id)
      onRevoked(connection.id)
    } catch (err) {
      setError(describeApiError(err, 'Could not revoke the connection.'))
      setBusy(false)
    }
  }

  return (
    <li className={s('row')}>
      <div className={s('rowMain')}>
        <strong>{connection.label}</strong>
        <span className={s('meta')}>
          {providerName(connection.provider)} · last verified {formatWhen(connection.lastVerifiedAt)}
        </span>
      </div>
      <div className={s('actions')}>
        <Button type="button" size="sm" variant="secondary" onClick={() => { setError(null); setMode(mode === 'rotate' ? 'idle' : 'rotate') }} disabled={busy}>
          Rotate credential
        </Button>
        <Button type="button" size="sm" variant="danger" onClick={() => { setError(null); setMode('revoke') }} disabled={busy}>
          Revoke
        </Button>
      </div>

      {mode === 'rotate' ? (
        <form className={s('inlineForm')} onSubmit={(e) => void rotate(e)} autoComplete="off">
          <Field
            label={`New API token for ${connection.label}`}
            name={`rotate-${connection.id}`}
            type="password"
            value={credential}
            onChange={setCredential}
            required
            autoComplete="off"
            hint="Write-only. The old credential is replaced once the new one verifies."
          />
          <div className={s('actions')}>
            <Button type="submit" size="sm" loading={busy}>
              Verify and replace
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setCredential(''); setMode('idle') }} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'revoke' ? (
        <div ref={revokeRef} tabIndex={-1} className={s('confirm')} role="alertdialog" aria-label={`Confirm revoking ${connection.label}`}>
          <p className={s('note')}>
            Revoking deletes the stored credential permanently. Revoking also removes its sync targets and their run history. Secrets
            already pushed to the target stay there. This does not revoke the token at the provider; do that there as well.
          </p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void revoke()}>
              Yes, revoke
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}

export function ConnectionsList({
  connections,
  onChanged,
  onRevoked,
}: {
  connections: ConnectionDto[]
  onChanged: (connection: ConnectionDto) => void
  onRevoked: (id: string) => void
}) {
  return (
    <section aria-labelledby="connections-title" className={s('block')}>
      <h2 id="connections-title" className={s('blockTitle')}>
        Connections
      </h2>
      {connections.length === 0 ? (
        <EmptyState title="No connections yet" description="Connect a provider above. Credentials are write-only and never shown after you save them." />
      ) : (
        <Card tone="light">
          <ul className={s('list')}>
            {connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} onChanged={onChanged} onRevoked={onRevoked} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  )
}
