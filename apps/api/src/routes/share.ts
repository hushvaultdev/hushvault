import { Hono } from 'hono'
import type { Env } from '../index'

export const shareRoutes = new Hono<{ Bindings: Env }>()

// POST /api/share — create a one-time share link
shareRoutes.post('/', async (c) => {
  // TODO:
  // 1. Receive client-encrypted payload (zero-knowledge: server never sees plaintext)
  // 2. Generate random token (not the encryption key — that stays in URL fragment)
  // 3. Store in D1 with expiry + maxViews
  // 4. Return { token, url: "https://hushvault.dev/share/{token}#{encryptionKey}" }
  return c.json({ message: 'TODO: create share link' }, 501)
})

// GET /api/share/:token — retrieve share link payload
shareRoutes.get('/:token', async (c) => {
  const token = c.req.param('token')
  // TODO:
  // 1. Look up token in D1
  // 2. Check expiry and viewCount < maxViews
  // 3. Increment viewCount
  // 4. Return encryptedPayload (client decrypts using key from URL fragment)
  return c.json({ message: `TODO: get share ${token}` }, 501)
})
