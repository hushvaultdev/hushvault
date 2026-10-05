'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useOrgs } from '@/lib/org-context'
import { ROLE_LABEL, shortId } from '@/lib/orgs-helpers'

import styles from './org-switcher.module.css'

const s = (name: string) => styles[name]

/**
 * The organisation the session is working in, shown at all times, and a menu to change it.
 *
 * The label is the name of the org the access token acts in. When the list of organisations has
 * not loaded (or this API deployment does not have /api/orgs at all) the id is shown instead of a
 * name: a name that might belong to a different organisation than the data on the page is the
 * failure this whole feature exists to prevent.
 */
export function OrgSwitcher() {
  const { orgs, status, currentOrg, currentOrgId, currentRole, switching, switchTo, error, reload } = useOrgs()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[data-item]')?.focus()
  }, [open])

  const label = currentOrg?.name ?? shortId(currentOrgId)
  const unknownName = currentOrg === null
  // The menu stays usable while the list is reloading (after a switch, for instance) and after a
  // failed reload: the organisations in hand are still the caller's. It disappears only where
  // there is genuinely nothing to switch between.
  const canSwitch = orgs.length > 0 && status !== 'missing'
  const busy = switching !== null

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-item]') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const index = items.findIndex((el) => el === document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1 + items.length) % items.length
            : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className={s('wrap')} ref={wrapRef}>
      {canSwitch ? (
        <button
          type="button"
          ref={triggerRef}
          className={s('trigger')}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          <span className={s('labels')}>
            <span className={s('eyebrow')}>Organisation</span>
            <span className={unknownName ? `${s('name')} ${s('nameUnknown')}` : s('name')}>{label}</span>
          </span>
          {currentRole ? <span className={s('role')}>{ROLE_LABEL[currentRole]}</span> : null}
          <span aria-hidden="true" className={s('chevron')}>
            ▾
          </span>
        </button>
      ) : (
        <div className={s('static')}>
          <span className={s('labels')}>
            <span className={s('eyebrow')}>Organisation</span>
            <span className={unknownName ? `${s('name')} ${s('nameUnknown')}` : s('name')}>{label}</span>
          </span>
          {currentRole ? <span className={s('role')}>{ROLE_LABEL[currentRole]}</span> : null}
          {status === 'missing' ? (
            <span className={s('note')}>
              One organisation. Switching is not available on this deployment yet.
            </span>
          ) : null}
          {status === 'error' ? (
            <button type="button" className={s('retry')} onClick={reload}>
              Retry loading organisations
            </button>
          ) : null}
          {status === 'loading' ? <span className={s('note')}>Loading…</span> : null}
        </div>
      )}

      {open && canSwitch ? (
        <div className={s('menu')} role="menu" aria-label="Switch organisation" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {orgs.map((org) => {
            const isCurrent = org.id === currentOrgId
            return (
              <button
                key={org.id}
                type="button"
                data-item
                role="menuitemradio"
                aria-checked={isCurrent}
                className={`${s('item')} ${isCurrent ? s('itemCurrent') : ''}`.trim()}
                disabled={busy}
                onClick={() => {
                  if (isCurrent) {
                    close(true)
                    return
                  }
                  close(false)
                  void switchTo(org.id)
                }}
              >
                <span className={s('itemName')}>{org.name}</span>
                <span className={s('itemMeta')}>
                  {ROLE_LABEL[org.role]}
                  {isCurrent ? ' · current' : ''}
                </span>
              </button>
            )
          })}
          <Link data-item role="menuitem" href="/organisations" className={s('item')} onClick={() => setOpen(false)}>
            <span className={s('itemName')}>Manage organisations</span>
            <span className={s('itemMeta')}>Create one, or see all of yours</span>
          </Link>
          <Link data-item role="menuitem" href="/members" className={s('item')} onClick={() => setOpen(false)}>
            <span className={s('itemName')}>Members and invitations</span>
            <span className={s('itemMeta')}>For {label}</span>
          </Link>
        </div>
      ) : null}

      <span className={s('srOnly')} role="status" aria-live="polite">
        {busy ? 'Switching organisation…' : ''}
      </span>
      {error ? (
        <p className={s('error')} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
