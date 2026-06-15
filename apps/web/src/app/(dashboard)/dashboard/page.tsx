'use client'

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { ApiError, apiFetch } from '@/lib/api'
import type { ProjectRow } from '@/lib/types'

import styles from '../dashboard.module.css'

const s = (name: string) => styles[name]

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setProjects(await apiFetch<ProjectRow[]>('/api/projects'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load projects.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      await apiFetch('/api/projects', { method: 'POST', body: { name, description: description || undefined } })
      setName('')
      setDescription('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create project.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <div className={s('pageHeader')}>
        <div>
          <h1 className={s('pageTitle')}>Projects</h1>
          <p className={s('pageSubtitle')}>Group secrets by application and manage them per environment.</p>
        </div>
      </div>

      <Card className={s('panel')} tone="light">
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>New project</h2>
        <form className={s('inlineForm')} onSubmit={onCreate}>
          <Field label="Name" name="name" value={name} onChange={setName} placeholder="Billing service" required />
          <Field label="Description" name="description" value={description} onChange={setDescription} placeholder="Optional" />
          <div className={s('formAction')}>
            <Button type="submit" variant="primary" loading={creating}>Create</Button>
          </div>
        </form>
        {error ? <p className={s('error')} role="alert">{error}</p> : null}
      </Card>

      {loading ? (
        <p className={s('loading')}>Loading projects…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create your first project above, or follow the guided setup to add a project, your first secret, and the CLI."
          action={<Button variant="primary" href="/onboarding">Start guided setup</Button>}
        />
      ) : (
        <div className={s('grid')}>
          {projects.map((project) => (
            <Card
              key={project.id}
              className={s('projectCard')}
              tone="light"
            >
              <h3 className={s('projectName')}>{project.name}</h3>
              <span className={s('projectSlug')}>{project.slug}</span>
              {project.description ? <p className={s('projectDesc')}>{project.description}</p> : null}
              <Button variant="secondary" href={`/projects/${project.id}`}>Open</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
