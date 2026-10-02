import { Command } from 'commander'
import chalk from 'chalk'
import { ApiClient } from '../api.js'
import { findProjectConfig } from '../config/project.js'
import { createAuthedClient, resolveApiUrl } from '../lib/context.js'
import { readValue } from './set.js'
import { fail } from '../lib/fail.js'

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Client-side encrypt with a one-time AES-256-GCM key (WebCrypto).
 * Payload = base64url(iv[12] || ciphertext+tag); key = base64url(raw 32 bytes).
 */
export async function encryptForShare(plaintext: string): Promise<{ encryptedPayload: string; key: string }> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const payload = new Uint8Array(iv.length + ct.length)
  payload.set(iv, 0)
  payload.set(ct, iv.length)
  const raw = new Uint8Array(await subtle.exportKey('raw', key))
  return { encryptedPayload: toBase64Url(payload), key: toBase64Url(raw) }
}

export async function shareAction(
  client: ApiClient,
  value: string,
  options: { views?: string | undefined; hours?: string | undefined },
  now: () => number = Date.now,
): Promise<string> {
  const views = Number(options.views ?? '1')
  const hours = Number(options.hours ?? '24')
  if (!Number.isInteger(views) || views < 1 || views > 100) throw new Error('--views must be an integer between 1 and 100')
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) throw new Error('--hours must be between 0 and 168 (share links expire after at most 7 days)')
  if (value.length === 0) throw new Error('Nothing to share: value is empty')

  const { encryptedPayload, key } = await encryptForShare(value)
  const expiresAt = new Date(now() + hours * 3600_000).toISOString()
  const { url } = await client.createShare({ encryptedPayload, expiresAt, maxViews: views })
  // The key lives only in the URL fragment; it is never sent to the server.
  return `${url}#${key}`
}

export const shareCommand = new Command('share')
  .description('Create a temporary E2E encrypted share link for a secret value')
  .argument('[value]', 'Secret value to share (omit or "-" to read from stdin)')
  .option('--views <n>', 'Max number of views', '1')
  .option('--hours <n>', 'Expiry in hours', '24')
  .action(async (valueArg: string | undefined, options: { views: string; hours: string }) => {
    try {
      const found = await findProjectConfig()
      const apiUrl = await resolveApiUrl(undefined, found?.config.apiUrl)
      const client = await createAuthedClient(apiUrl)
      const link = await shareAction(client, await readValue(valueArg), options)
      console.log(chalk.green('✓ Share link created'))
      console.log(link)
      console.log(chalk.gray(`  Expires in ${options.hours}h, max ${options.views} view(s). The decryption key is only in the #fragment.`))
    } catch (err) {
      fail(err, 'Creating share links')
    }
  })
