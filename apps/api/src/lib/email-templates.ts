// Static templates for verification / reset mail. They contain a link and plain text only: never a
// password, never a token in a query string. Links put the token in the URL FRAGMENT, which browsers
// do not send to servers, referrers or access logs; the web page reads it and POSTs it.
import type { Env } from '../index'
import type { EmailMessage } from './email'

export type LinkEnv = Pick<Env, 'WEB_APP_URL'>

/**
 * `<WEB_APP_URL origin><path>#token=<token>`. The base comes ONLY from the WEB_APP_URL setting,
 * never from a request Host/Origin header. Returns null when it is not configured or invalid.
 */
export function buildTokenLink(env: LinkEnv, path: string, token: string): string | null {
  if (!path.startsWith('/')) return null
  let origin: string
  try {
    origin = new URL(env.WEB_APP_URL ?? '').origin
  } catch {
    return null
  }
  if (origin === 'null') return null
  return `${origin}${path}#token=${encodeURIComponent(token)}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function layout(heading: string, paragraphs: string[], link?: { url: string; label: string }): { text: string; html: string } {
  const text = [heading, '', ...paragraphs, ...(link ? ['', `${link.label}: ${link.url}`] : []), '', '-- HushVault'].join('\n')
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
  const button = link ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` : ''
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px"><h2>${escapeHtml(heading)}</h2>${body}${button}<p style="color:#666">HushVault</p></div>`
  return { text, html }
}

export function verifyEmailMessage(to: string, link: string): EmailMessage {
  const { text, html } = layout(
    'Confirm your email address',
    [
      'Confirm that this is your email address to finish setting up your HushVault account. The link works once and expires in 24 hours.',
      'If you did not create a HushVault account, ignore this email.',
    ],
    { url: link, label: 'Confirm email' },
  )
  return { to, subject: 'Confirm your HushVault email address', text, html }
}

export function resetPasswordMessage(to: string, link: string): EmailMessage {
  const { text, html } = layout(
    'Reset your password',
    [
      'We received a request to reset the password for your HushVault account. The link works once and expires in 60 minutes.',
      'If you did not request this, ignore this email; your password will not change.',
    ],
    { url: link, label: 'Reset password' },
  )
  return { to, subject: 'Reset your HushVault password', text, html }
}

export function passwordChangedMessage(to: string): EmailMessage {
  const { text, html } = layout('Your password was changed', [
    'The password for your HushVault account was just changed, and existing sessions and API keys were revoked.',
    'If this was not you, reset your password again immediately and contact security@hushvault.dev.',
  ])
  return { to, subject: 'Your HushVault password was changed', text, html }
}
