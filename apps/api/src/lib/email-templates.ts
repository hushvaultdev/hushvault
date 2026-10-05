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

export function resetPasswordMessage(to: string, link: string, oauthOnly = false): EmailMessage {
  const { text, html } = layout(
    'Reset your password',
    [
      ...(oauthOnly ? ['Your account normally signs in with GitHub or Google. This link lets you add a password as well.'] : []),
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

/**
 * An invitation to an organisation (issue #82 Lane B).
 *
 * The organisation's name is in here because the message goes to the address an admin of that
 * organisation chose to invite — that is the whole point of the mail. It is deliberately NOT in
 * the `INVITE_EMAIL_MISMATCH` refusal, which anyone holding a forwarded link can trigger: the
 * mail tells the invited address which organisation, the API tells a stranger nothing.
 *
 * Nothing else is included. Not who invited them (an internal address is not the recipient's
 * business, and would turn the mail into a directory lookup), and no secret material beyond the
 * single-use token the link carries in its fragment.
 */
export function orgInviteMessage(to: string, link: string, orgName: string): EmailMessage {
  const { text, html } = layout(
    `You have been invited to ${orgName}`,
    [
      `You have been invited to join the HushVault organisation "${orgName}". The link works once and expires in 7 days.`,
      'An invitation belongs to an email address, so it can only be accepted while signed in to a HushVault account'
      + ' on this address, with the address confirmed. You can create that account from the link.',
      'If you were not expecting this, ignore this email. Nothing is added to any account until the invitation is accepted.',
    ],
    { url: link, label: 'Accept invitation' },
  )
  return { to, subject: `Join ${orgName} on HushVault`, text, html }
}

/**
 * The invitation link: `buildTokenLink`'s fragment form, plus the non-secret `email` hint the
 * accept page reads (orgs-helpers.parseInviteLink). The hint is what lets a signed-out visitor be
 * told WHICH address to sign in with before the API has been asked anything — without it the page
 * can only say "sign in with the invited address" and not name it. It rides in the fragment with
 * the token, so it reaches no server log and no `Referer` header either, and it is an address the
 * recipient already owns.
 */
export function buildInviteLink(env: LinkEnv, token: string, email: string): string | null {
  const base = buildTokenLink(env, '/invites/accept', token)
  return base === null ? null : `${base}&email=${encodeURIComponent(email)}`
}
