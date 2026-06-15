'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { ApiError, apiFetch } from '@/lib/api'
import type { EnvironmentRow, ProjectRow, SecretRow, SecretValue } from '@/lib/types'

import styles from '../../dashboard.module.css'

const s = (name: string) => styles[name]

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()

  const [project, setProject] = useState<ProjectRow | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([])
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [envName, setEnvName] = useState('')
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [busy, setBusy] = useState(false)

  const loadProjectAndEnvs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [proj, envs] = await Promise.all([
        apiFetch<ProjectRow>(`/api/projects/${projectId}`),
        apiFetch<EnvironmentRow[]>(`/api/environments?projectId=${encodeURIComponent(projectId)}`),
      ])
      setProject(proj)
      setEnvironments(envs)
      setSelectedEnvId((current) => current ?? envs[0]?.id ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load project.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadSecrets = useCallback(async (envId: string) => {
    setError(null)
    try {
      setSecrets(await apiFetch<SecretRow[]>(`/api/secrets?envId=${encodeURIComponent(envId)}`))
      setRevealed({})
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load secrets.')
    }
  }, [])

  useEffect(() => {
    void loadProjectAndEnvs()
  }, [loadProjectAndEnvs])

  useEffect(() => {
    if (selectedEnvId) void loadSecrets(selectedEnvId)
    else setSecrets([])
  }, [selectedEnvId, loadSecrets])

  async function onCreateEnv(e: React.FormEvent) {
    e.preventDefault()
    if (!envName.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await apiFetch<{ id: string }>('/api/environments', {
        method: 'POST',
        body: { projectId, name: envName },
      })
      setEnvName('')
      await loadProjectAndEnvs()
      setSelectedEnvId(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create environment.')
    } finally {
      setBusy(false)
    }
  }

  async function onCreateSecret(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedEnvId || !secretName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/secrets', {
        method: 'POST',
        body: { projectId, envId: selectedEnvId, name: secretName, value: secretValue },
      })
      setSecretName('')
      setSecretValue('')
      await loadSecrets(selectedEnvId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create secret.')
    } finally {
      setBusy(false)
    }
  }

  async function onReveal(secret: SecretRow) {
    if (!selectedEnvId) return
    if (revealed[secret.id] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[secret.id]
        return next
      })
      return
    }
    try {
      const detail = await apiFetch<SecretValue>(
        `/api/secrets/${encodeURIComponent(secret.name)}?envId=${encodeURIComponent(selectedEnvId)}`,
      )
      setRevealed((prev) => ({ ...prev, [secret.id]: detail.value }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reveal secret.')
    }
  }

  async function onDelete(secret: SecretRow) {
    if (!selectedEnvId) return
    setError(null)
    try {
      await apiFetch(`/api/secrets/${secret.id}`, { method: 'DELETE' })
      await loadSecrets(selectedEnvId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete secret.')
    }
  }

  return (
    <div>
      <Link href="/dashboard" className={s('backLink')}>← All projects</Link>
      <div className={s('pageHeader')}>
        <div>
          <h1 className={s('pageTitle')}>{project?.name ?? 'Project'}</h1>
          <p className={s('pageSubtitle')}>Manage secrets per environment with envelope encryption.</p>
        </div>
      </div>

      {loading ? <p className={s('loading')}>Loading…</p> : null}
      {error ? <p className={s('error')} role="alert">{error}</p> : null}

      {!loading ? (
        <>
          <div className={s('envBar')}>
            {environments.map((env) => (
              <button
                key={env.id}
                type="button"
                className={`${s('envChip')} ${selectedEnvId === env.id ? s('envChipActive') : ''}`.trim()}
                onClick={() => setSelectedEnvId(env.id)}
              >
                {env.name}
              </button>
            ))}
            <form className={s('inlineForm')} onSubmit={onCreateEnv} style={{ flex: '0 0 auto' }}>
              <input
                className="hv-env-input"
                aria-label="New environment name"
                placeholder="New environment"
                value={envName}
                onChange={(e) => setEnvName(e.target.value)}
                style={{ minHeight: 40, padding: '8px 12px', borderRadius: 999, border: '1px solid var(--border)' }}
              />
              <Button type="submit" variant="ghost" loading={busy}>Add env</Button>
            </form>
          </div>

          {environments.length === 0 ? (
            <EmptyState
              title="No environments yet"
              description="Create an environment (e.g. production, staging) above to start adding secrets."
            />
          ) : selectedEnvId ? (
            <>
              <Card className={s('panel')} tone="light">
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Add secret</h2>
                <form className={s('inlineForm')} onSubmit={onCreateSecret}>
                  <Field label="Name" name="secretName" value={secretName} onChange={setSecretName} placeholder="DATABASE_URL" required />
                  <Field label="Value" name="secretValue" value={secretValue} onChange={setSecretValue} placeholder="postgres://…" />
                  <div className={s('formAction')}>
                    <Button type="submit" variant="primary" loading={busy}>Add</Button>
                  </div>
                </form>
              </Card>

              {secrets.length === 0 ? (
                <EmptyState title="No secrets in this environment" description="Add your first secret above." />
              ) : (
                <table className={s('table')}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Value</th>
                      <th>Type</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {secrets.map((secret) => (
                      <tr key={secret.id}>
                        <td className={s('secretName')}>{secret.name}</td>
                        <td className={s('secretValue')}>
                          {revealed[secret.id] !== undefined ? revealed[secret.id] : '••••••••'}
                        </td>
                        <td>
                          {secret.is_computed ? <Badge tone="accent">Computed</Badge> : <Badge tone="neutral">Static</Badge>}
                        </td>
                        <td>
                          <span className={s('rowActions')}>
                            <Button variant="ghost" onClick={() => onReveal(secret)}>
                              {revealed[secret.id] !== undefined ? 'Hide' : 'Reveal'}
                            </Button>
                            <Button variant="ghost" onClick={() => onDelete(secret)}>Delete</Button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
