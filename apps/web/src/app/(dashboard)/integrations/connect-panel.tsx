'use client'

import type { IntegrationInfo } from '@hushvault/shared/integrations'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { createConnection, type ConnectionDto } from '@/lib/integrations-api'
import {
  describeApiError,
  docsUrl,
  permissionGuidance,
  validateAccountId,
  validateCredential,
  validateLabel,
} from '@/lib/integrations-helpers'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

export function ConnectPanel({
  provider,
  onConnected,
  onCancel,
}: {
  provider: IntegrationInfo
  onConnected: (connection: ConnectionDto) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [accountId, setAccountId] = useState('')
  // The credential lives only in this field's state and is cleared as soon as the form is submitted.
  const [credential, setCredential] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsAccountId = provider.id === 'cloudflare-workers'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem =
      validateLabel(label) ?? (needsAccountId ? validateAccountId(accountId.trim()) : null) ?? validateCredential(credential)
    if (problem) {
      setError(problem)
      return
    }
    const secret = credential
    setCredential('')
    setBusy(true)
    setError(null)
    try {
      const created = await createConnection({
        provider: provider.id,
        label: label.trim(),
        credential: secret,
        config: needsAccountId ? { accountId: accountId.trim() } : {},
      })
      onConnected(created)
    } catch (err) {
      setError(describeApiError(err, 'Could not connect. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="light" className={s('panel')}>
      <form onSubmit={(e) => void submit(e)} className={s('form')} aria-labelledby="connect-title" autoComplete="off">
        <h2 id="connect-title" className={s('panelTitle')}>
          Connect {provider.name}
        </h2>
        <p className={s('note')}>
          {permissionGuidance(provider.id)}{' '}
          <a href={docsUrl(provider.id)} target="_blank" rel="noreferrer noopener">
            Setup guide
          </a>
        </p>
        <Field label="Label" name="label" value={label} onChange={setLabel} placeholder="e.g. Production account" required hint="1 to 64 characters, unique in your organisation." />
        {needsAccountId ? (
          <Field label="Account ID" name="accountId" value={accountId} onChange={setAccountId} placeholder="32-character hex ID" required autoComplete="off" />
        ) : null}
        <Field
          label="API token"
          name="credential"
          type="password"
          value={credential}
          onChange={setCredential}
          required
          autoComplete="off"
          hint="Write-only: it is verified with a read-only call, stored encrypted and never shown again."
        />
        {error ? (
          <p className={s('error')} role="alert">
            {error}
          </p>
        ) : null}
        <div className={s('actions')}>
          <Button type="submit" loading={busy}>
            Verify and connect
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
