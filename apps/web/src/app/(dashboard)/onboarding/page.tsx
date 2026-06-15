'use client'

import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { ApiError, apiFetch } from '@/lib/api'

import styles from './onboarding.module.css'

const s = (name: string) => styles[name]

const STEPS = ['Create project', 'First secret', 'Install CLI'] as const

const CLI_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: 'Install the HushVault CLI globally', command: 'npm install -g hushvault' },
  { label: 'Authenticate with your account', command: 'hushvault login' },
  { label: 'Link this directory to a project', command: 'hushvault init' },
]

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
          return (
            <div className={s('step')} role="listitem" aria-current={isActive ? 'step' : undefined} key={label}>
              <span className={badgeClass} aria-hidden="true">{isDone ? '✓' : number}</span>
              <span className={labelClass}>{label}</span>
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
                value={secretValue}
                onChange={setSecretValue}
                placeholder="postgres://…"
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
          <ul className={s('cliList')}>
            {CLI_COMMANDS.map(({ label, command }) => (
              <li className={s('cliStep')} key={command}>
                <span className={s('cliStepLabel')}>{label}</span>
                <code className={s('cliCommand')}>{command}</code>
              </li>
            ))}
          </ul>
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
