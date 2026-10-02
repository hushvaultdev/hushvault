'use client'

import type { SyncPlanDto, SyncRunDto, SyncTargetDto } from '@hushvault/shared/integrations'
import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { ApiError, apiFetch } from '@/lib/api'
import {
  createTarget,
  deleteTarget,
  listRuns,
  previewTarget,
  runTarget,
  type ConnectionDto,
} from '@/lib/integrations-api'
import {
  blockerLabel,
  describeApiError,
  formatWhen,
  groupPlan,
  parseNameList,
  planIsEmpty,
  resourceText,
  runCountsText,
  targetNeedsAttention,
  validateNameFilter,
  validateScriptName,
} from '@/lib/integrations-helpers'
import type { EnvironmentRow, ProjectRow } from '@/lib/types'

import styles from './integrations.module.css'

const s = (name: string) => styles[name]

function PlanView({ plan }: { plan: SyncPlanDto }) {
  const groups = groupPlan(plan)
  if (planIsEmpty(plan)) return <p className={s('note')}>Nothing to do: the target already matches.</p>
  return (
    <div className={s('plan')}>
      {plan.blockers.length > 0 ? (
        <div className={s('blockers')} role="alert">
          <strong>This run is blocked</strong>
          <ul>
            {plan.blockers.map((b) => (
              <li key={b.code}>
                {blockerLabel(b.code)}: {b.names.join(', ') || 'see target configuration'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          <h4 className={s('planHeading')}>
            {g.label} ({g.names.length})
          </h4>
          <p className={s('names')}>{g.names.join(', ')}</p>
        </div>
      ))}
    </div>
  )
}

function TargetRow({
  target,
  label,
  projectName,
  envName,
  onDeleted,
  onRan,
}: {
  target: SyncTargetDto
  label: string
  projectName: string
  envName: string
  onDeleted: (id: string) => void
  onRan: (targetId: string) => void
}) {
  const [busy, setBusy] = useState<'preview' | 'run' | 'delete' | null>(null)
  const [plan, setPlan] = useState<SyncPlanDto | null>(null)
  const [result, setResult] = useState<SyncRunDto | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function preview() {
    setBusy('preview')
    setError(null)
    setResult(null)
    try {
      setPlan(await previewTarget(target.id))
    } catch (err) {
      setError(describeApiError(err, 'Could not build the preview.'))
    } finally {
      setBusy(null)
    }
  }

  async function run() {
    setBusy('run')
    setError(null)
    setPlan(null)
    try {
      const done = await runTarget(target.id)
      setResult(done)
      onRan(target.id)
    } catch (err) {
      setError(describeApiError(err, 'The run failed.'))
      // A blocked run is explained by the preview, so show it.
      if (err instanceof ApiError && err.code === 'SYNC_BLOCKED') {
        try {
          setPlan(await previewTarget(target.id))
        } catch {
          // The generic message above is enough.
        }
      }
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setBusy('delete')
    setError(null)
    try {
      await deleteTarget(target.id)
      onDeleted(target.id)
    } catch (err) {
      setError(describeApiError(err, 'Could not delete the target.'))
      setBusy(null)
    }
  }

  return (
    <li className={s('row')}>
      <div className={s('rowMain')}>
        <strong>
          {projectName} / {envName}
        </strong>
        <span className={s('meta')}>
          Worker {resourceText(target.resource)} via {label} · last run {formatWhen(target.lastRunAt)}
          {target.lastRunStatus ? ` (${target.lastRunStatus})` : ''}
          {target.deleteRemoved ? ' · deletes removed secrets' : ''}
        </span>
      </div>
      <div className={s('badges')}>
        {targetNeedsAttention(target) ? <Badge tone="warning">Needs attention</Badge> : <Badge tone="success">Active</Badge>}
      </div>
      <div className={s('actions')}>
        <Button type="button" size="sm" variant="secondary" onClick={() => void preview()} loading={busy === 'preview'} disabled={busy !== null}>
          Preview
        </Button>
        <Button type="button" size="sm" onClick={() => void run()} loading={busy === 'run'} disabled={busy !== null}>
          Run now
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
          Remove target
        </Button>
      </div>

      {confirmDelete ? (
        <div className={s('confirm')} role="alertdialog" aria-label="Confirm removing this sync target">
          <p className={s('note')}>Removes this sync target and its history. Secrets already on the target are left in place.</p>
          <div className={s('actions')}>
            <Button type="button" size="sm" variant="danger" loading={busy === 'delete'} onClick={() => void remove()}>
              Yes, remove
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy !== null}>
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
      {plan ? <PlanView plan={plan} /> : null}
      {result ? (
        <p className={s('note')} role="status">
          Run {result.status}: {runCountsText(result.counts)}.
        </p>
      ) : null}
    </li>
  )
}

function CreateTargetForm({
  connections,
  projects,
  onCreated,
  onCancel,
}: {
  connections: ConnectionDto[]
  projects: ProjectRow[]
  onCreated: (target: SyncTargetDto) => void
  onCancel: () => void
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([])
  const [envId, setEnvId] = useState('')
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [scriptName, setScriptName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [deny, setDeny] = useState('')
  const [deleteRemoved, setDeleteRemoved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      setEnvironments([])
      setEnvId('')
      return
    }
    let cancelled = false
    void apiFetch<EnvironmentRow[]>(`/api/environments?projectId=${encodeURIComponent(projectId)}`)
      .then((envs) => {
        if (cancelled) return
        setEnvironments(envs)
        setEnvId(envs[0]?.id ?? '')
      })
      .catch(() => {
        if (cancelled) return
        setEnvironments([])
        setEnvId('')
        setError('Could not load environments for this project.')
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const connection = connections.find((c) => c.id === connectionId)
    const accountId = connection && typeof connection.config['accountId'] === 'string' ? connection.config['accountId'] : ''
    const denyList = parseNameList(deny)
    const problem =
      (!projectId || !envId || !connection ? 'Choose a project, an environment and a connection.' : null) ??
      validateScriptName(scriptName.trim()) ??
      validateNameFilter(prefix.trim(), denyList)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await createTarget({
        projectId,
        envId,
        connectionId,
        resource: { accountId, scriptName: scriptName.trim() },
        nameFilter: { ...(prefix.trim() ? { prefix: prefix.trim() } : {}), ...(denyList.length > 0 ? { deny: denyList } : {}) },
        deleteRemoved,
      })
      onCreated(created)
    } catch (err) {
      setError(describeApiError(err, 'Could not create the sync target.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="light" className={s('panel')}>
      <form className={s('form')} onSubmit={(e) => void submit(e)} aria-labelledby="target-title">
        <h3 id="target-title" className={s('panelTitle')}>
          New sync target
        </h3>
        <p className={s('note')}>One-way: HushVault pushes to the target. Nothing is ever read back or imported.</p>

        <label className={s('selectField')}>
          <span className={s('selectLabel')}>Project</span>
          <select className={s('select')} value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className={s('selectField')}>
          <span className={s('selectLabel')}>Environment</span>
          <select className={s('select')} value={envId} onChange={(e) => setEnvId(e.target.value)} required>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </label>
        <label className={s('selectField')}>
          <span className={s('selectLabel')}>Connection</span>
          <select className={s('select')} value={connectionId} onChange={(e) => setConnectionId(e.target.value)} required>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <Field label="Worker name" name="scriptName" value={scriptName} onChange={setScriptName} placeholder="my-worker" required hint="The Worker that receives the secrets. It must already exist." />
        <Field label="Name prefix (optional)" name="prefix" value={prefix} onChange={setPrefix} placeholder="APP_" hint="Only secrets starting with this prefix are pushed." />
        <Field label="Never push these names (optional)" name="deny" value={deny} onChange={setDeny} placeholder="LOCAL_ONLY, DEBUG_TOKEN" hint="Comma separated. ENCRYPTION_MASTER_KEY, ENCRYPTION_KEY_V* and JWT_SECRET are never synced." />

        <label className={s('check')}>
          <input type="checkbox" checked={deleteRemoved} onChange={(e) => setDeleteRemoved(e.target.checked)} />
          <span>
            <strong>Delete removed secrets on the target</strong>
            <span className={s('note')}>
              Off by default. When on, a secret that HushVault itself pushed earlier and that you later delete here is also deleted from the
              Worker. Secrets HushVault did not create are never touched.
            </span>
          </span>
        </label>

        {error ? (
          <p className={s('error')} role="alert">
            {error}
          </p>
        ) : null}
        <div className={s('actions')}>
          <Button type="submit" loading={busy}>
            Create target
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

function RunHistory({ targets, refreshKey }: { targets: SyncTargetDto[]; refreshKey: number }) {
  const [targetId, setTargetId] = useState('')
  const [runs, setRuns] = useState<SyncRunDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const selected = targets.some((t) => t.id === targetId) ? targetId : (targets[0]?.id ?? '')

  const load = useCallback(async (id: string) => {
    setError(null)
    try {
      setRuns(await listRuns(id))
    } catch (err) {
      setRuns([])
      setError(describeApiError(err, 'Could not load run history.'))
    }
  }, [])

  useEffect(() => {
    if (selected) void load(selected)
  }, [selected, refreshKey, load])

  if (targets.length === 0) return null

  return (
    <section aria-labelledby="history-title" className={s('block')}>
      <h3 id="history-title" className={s('blockTitle')}>
        Run history
      </h3>
      <label className={s('selectField')}>
        <span className={s('selectLabel')}>Target</span>
        <select className={s('select')} value={selected} onChange={(e) => setTargetId(e.target.value)}>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {resourceText(t.resource)} ({t.id.slice(0, 6)})
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}
      <div className={s('tableWrap')}>
        <table className={s('table')}>
          <caption className={s('srOnly')}>Sync runs, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Trigger</th>
              <th scope="col">Status</th>
              <th scope="col">Result</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td colSpan={5}>No runs yet.</td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr key={r.id}>
                  <td>{formatWhen(r.startedAt)}</td>
                  <td>{r.trigger}</td>
                  <td>{r.status}</td>
                  <td>{runCountsText(r.counts)}</td>
                  <td>{r.errorCode ?? '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function TargetsSection({
  connections,
  targets,
  onTargetsChange,
  onRefresh,
}: {
  connections: ConnectionDto[]
  targets: SyncTargetDto[]
  onTargetsChange: (targets: SyncTargetDto[]) => void
  onRefresh: () => void
}) {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [envNames, setEnvNames] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [historyKey, setHistoryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void apiFetch<ProjectRow[]>('/api/projects')
      .then(async (rows) => {
        if (cancelled) return
        setProjects(rows)
        const entries = await Promise.all(
          rows.map((p) =>
            apiFetch<EnvironmentRow[]>(`/api/environments?projectId=${encodeURIComponent(p.id)}`).catch(() => [] as EnvironmentRow[]),
          ),
        )
        if (cancelled) return
        const names: Record<string, string> = {}
        for (const env of entries.flat()) names[env.id] = env.name
        setEnvNames(names)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your projects.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const connectionLabel = (id: string) => connections.find((c) => c.id === id)?.label ?? 'a revoked connection'
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Unknown project'

  return (
    <section aria-labelledby="targets-title" className={s('block')}>
      <div className={s('blockHead')}>
        <h2 id="targets-title" className={s('blockTitle')}>
          Sync targets
        </h2>
        {!creating ? (
          <Button type="button" size="sm" onClick={() => setCreating(true)} disabled={connections.length === 0 || projects.length === 0}>
            Add sync target
          </Button>
        ) : null}
      </div>
      <p className={s('note')}>
        The Free plan includes up to 2 sync targets per organisation. Reserved secrets (ENCRYPTION_MASTER_KEY, ENCRYPTION_KEY_V*,
        JWT_SECRET) are never synced.
      </p>
      {loadError ? (
        <p className={s('error')} role="alert">
          {loadError}
        </p>
      ) : null}

      {creating ? (
        <CreateTargetForm
          connections={connections}
          projects={projects}
          onCancel={() => setCreating(false)}
          onCreated={(t) => {
            onTargetsChange([...targets, t])
            setCreating(false)
          }}
        />
      ) : null}

      {targets.length === 0 ? (
        <EmptyState
          title="No sync targets"
          description={connections.length === 0 ? 'Connect a provider first, then add a target.' : 'Add a target to push an environment to a Worker.'}
        />
      ) : (
        <Card tone="light">
          <ul className={s('list')}>
            {targets.map((t) => (
              <TargetRow
                key={t.id}
                target={t}
                label={connectionLabel(t.connectionId)}
                projectName={projectName(t.projectId)}
                envName={envNames[t.envId] ?? 'environment'}
                onDeleted={(id) => onTargetsChange(targets.filter((x) => x.id !== id))}
                onRan={() => {
                  setHistoryKey((k) => k + 1)
                  onRefresh()
                }}
              />
            ))}
          </ul>
        </Card>
      )}

      <RunHistory targets={targets} refreshKey={historyKey} />
    </section>
  )
}
