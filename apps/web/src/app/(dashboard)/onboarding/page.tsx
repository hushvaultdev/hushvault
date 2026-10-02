'use client'

import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { CliInstallSteps } from '@/components/cli/cli-install'
import { ApiError, apiFetch } from '@/lib/api'

import styles from './onboarding.module.css'

const s = (name: string) => styles[name]

const STEPS = ['Create project', 'First secret', 'Install CLI'] as const

export default function OnboardingPage() {
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // Step 1 — project
  const [projectName, setProjectName] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [savedProjectName, setSavedProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)

  // Step 2 — environment + secret
  const [envName, setEnvName] = useState('')
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [creatingSecret, setCreatingSecret] = useState(false)

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault()
    if (!projectName.trim()) return
    setCreatingProject(true)
    setError(null)
    try {
      const created = await apiFetch<{ id: string; name: string }>('/api/projects', {
        method: 'POST',
        body: { name: projectName },
      })
      setProjectId(created.id)
      setSavedProjectName(created.name)
      setStep(2)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create project.')
    } finally {
      setCreatingProject(false)
    }
  }

  async function onCreateEnvAndSecret(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId || !envName.trim() || !secretName.trim()) return
    setCreatingSecret(true)
    setError(null)
    try {
      const env = await apiFetch<{ id: string }>('/api/environments', {
        method: 'POST',
        body: { projectId, name: envName },
      })
      await apiFetch('/api/secrets', {
        method: 'POST',
        body: { projectId, envId: env.id, name: secretName, value: secretValue },
      })
      setStep(3)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create environment and secret.')
    } finally {
      setCreatingSecret(false)
    }
  }

  return (
    <div>
      <div className={s('pageHeader')}>
        <h1 className={s('pageTitle')}>Get started</h1>
        <p className={s('pageSubtitle')}>Set up your first project, secret, and the CLI in three quick steps.</p>
      </div>

      <div className={s('stepper')} role="list" aria-label="Onboarding progress">
        {STEPS.map((label, index) => {
          const number = index + 1
          const isActive = number === step
          const isDone = number < step
          const badgeClass = `${s('stepBadge')} ${
            isDone ? s('stepBadgeDone') : isActive ? s('stepBadgeActive') : ''
          }`.trim()
          const labelClass = `${s('stepLabel')} ${isActive || isDone ? s('stepLabelActive') : ''}`.trim()
          // Steps are navigable: step 1 and the CLI step (3) are always reachable, so the
          // install instructions stay available after a project exists. Step 2 needs a project.
          const reachable = number !== 2 || projectId !== null
          return (
            <div className={s('step')} role="listitem" aria-current={isActive ? 'step' : undefined} key={label}>
              <button
                type="button"
                className={s('stepButton')}
                disabled={!reachable}
                onClick={() => { setError(null); setStep(number) }}
              >
                <span className={badgeClass} aria-hidden="true">{isDone ? '✓' : number}</span>
                <span className={labelClass}>{label}</span>
              </button>
              {number < STEPS.length ? <span className={s('stepConnector')} aria-hidden="true" /> : null}
            </div>
          )
        })}
      </div>

      {error ? <p className={s('error')} role="alert">{error}</p> : null}

      {step === 1 ? (
        <Card className={s('panel')} tone="light">
          <div>
            <h2 className={s('panelTitle')}>Create your first project</h2>
            <p className={s('panelSubtitle')}>Projects group secrets by application. You can add more later.</p>
          </div>
          <form className={s('form')} onSubmit={onCreateProject}>
            <Field
              label="Project name"
              name="projectName"
              value={projectName}
              onChange={setProjectName}
              placeholder="Billing service"
              required
            />
            <div className={s('formActions')}>
              <Button type="submit" variant="primary" loading={creatingProject}>
                Create project
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card className={s('panel')} tone="light">
          <div>
            <h2 className={s('panelTitle')}>Add an environment and your first secret</h2>
            <p className={s('panelSubtitle')}>
              Create an environment (e.g. production) and store a secret in it with envelope encryption.
            </p>
          </div>
          <form className={s('form')} onSubmit={onCreateEnvAndSecret}>
            <div className={s('subPanel')}>
              <h3 className={s('subPanelTitle')}>Environment</h3>
              <Field
                label="Environment name"
                name="envName"
                value={envName}
                onChange={setEnvName}
                placeholder="production"
                required
              />
            </div>
            <div className={s('subPanel')}>
              <h3 className={s('subPanelTitle')}>Secret</h3>
              <Field
                label="Secret name"
                name="secretName"
                value={secretName}
                onChange={setSecretName}
                placeholder="DATABASE_URL"
                required
              />
              <Field
                label="Secret value"
                name="secretValue"
                type="password"
                value={secretValue}
                onChange={setSecretValue}
                placeholder="postgres://…"
                autoComplete="off"
              />
            </div>
            <div className={s('formActions')}>
              <Button type="submit" variant="primary" loading={creatingSecret}>
                Save and continue
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card className={s('panel')} tone="light">
          <div>
            <p className={s('summary')}>
              <Badge tone="success">Setup complete</Badge>
              {savedProjectName ? <span>Project “{savedProjectName}” is ready.</span> : null}
            </p>
            <h2 className={s('panelTitle')}>Install the CLI</h2>
            <p className={s('panelSubtitle')}>Pull secrets into any environment straight from your terminal.</p>
          </div>
          <CliInstallSteps />
          <div className={s('doneActions')}>
            <Button variant="primary" href="/dashboard">Go to dashboard</Button>
            {projectId ? (
              <Button variant="secondary" href={`/projects/${projectId}`}>Open project</Button>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  )
}
