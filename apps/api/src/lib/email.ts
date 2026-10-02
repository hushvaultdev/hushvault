// Outbound transactional email (issue #26). Provider-neutral interface; the first backend is
// Cloudflare Email Service via a Workers `send_email` binding (issue #76).
//
// Rules: never log recipient addresses, links or tokens (only a short error code); a failed send
// must never fail the request that triggered it (callers run sends in the background).
import type { Env } from '../index'

export type EmailMessage = { to: string; subject: string; text: string; html: string }

export type EmailErrorCode =
  | 'EMAIL_NOT_CONFIGURED'
  | 'RECIPIENT_SUPPRESSED'
  | 'RATE_LIMITED'
  | 'SENDER_NOT_VERIFIED'
  | 'SEND_FAILED'

export type EmailSendResult = { ok: true } | { ok: false; code: EmailErrorCode }

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>
}

/** Minimal shape of the Workers send_email binding (`env.EMAIL.send({ from, to, subject, html, text })`). */
export type EmailBinding = {
  send(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/** Map the binding's string `.code` to an internal code; provider detail never leaves this module. */
export function mapEmailError(err: unknown): EmailErrorCode {
  const code = codeOf(err)
  if (code.includes('SUPPRESSED')) return 'RECIPIENT_SUPPRESSED'
  if (code.includes('RATE_LIMIT') || code.includes('DAILY_LIMIT')) return 'RATE_LIMITED'
  if (code.includes('SENDER_NOT_VERIFIED')) return 'SENDER_NOT_VERIFIED'
  return 'SEND_FAILED'
}

export class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: EmailBinding, private readonly from: string) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      await this.binding.send({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html })
      return { ok: true }
    } catch (err) {
      return { ok: false, code: mapEmailError(err) }
    }
  }
}

/** Used when no provider is configured: nothing is sent and the caller gets a code, not an exception. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(): Promise<EmailSendResult> {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED' }
  }
}

export function getEmailSender(env: Pick<Env, 'EMAIL' | 'MAIL_FROM'>): EmailSender {
  const from = env.MAIL_FROM?.trim()
  if (env.EMAIL && from) return new CloudflareEmailSender(env.EMAIL, from)
  return new UnconfiguredEmailSender()
}

let warnedUnconfigured = false

/**
 * Send and swallow failures: logs one structured, code-only line (a single warning for the
 * "not configured" case) and returns the result. Safe to call from waitUntil.
 */
export async function sendEmail(env: Pick<Env, 'EMAIL' | 'MAIL_FROM'>, message: EmailMessage, sender: EmailSender = getEmailSender(env)): Promise<EmailSendResult> {
  let result: EmailSendResult
  try {
    result = await sender.send(message)
  } catch {
    result = { ok: false, code: 'SEND_FAILED' }
  }
  if (!result.ok) {
    if (result.code === 'EMAIL_NOT_CONFIGURED') {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        console.warn(JSON.stringify({ level: 'warn', event: 'email.not_configured' }))
      }
    } else {
      console.error(JSON.stringify({ level: 'error', event: 'email.send_failed', code: result.code }))
    }
  }
  return result
}
