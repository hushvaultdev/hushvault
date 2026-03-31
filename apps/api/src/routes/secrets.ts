import { Hono } from 'hono'
import type { Env } from '../index'
import { encryptSecret, decryptSecret } from '../crypto/envelope'

export const secretRoutes = new Hono<{ Bindings: Env }>()

// GET /api/secrets?envId=xxx — list secrets (names only, no values)
secretRoutes.get('/', async (c) => {
  // TODO: auth middleware, query D1 for secret metadata
  return c.json({ message: 'TODO: list secrets' }, 501)
})

// GET /api/secrets/:name — get and decrypt a single secret
secretRoutes.get('/:name', async (c) => {
  const name = c.req.param('name')
  // TODO:
  // 1. Look up secret metadata in D1
  // 2. Fetch encrypted value from KV: key = "secret:{id}"
  // 3. Decrypt using envelope: decryptSecret(encryptedValue, wrappedDek, masterKey)
  // 4. If isComputed: resolve ${REFERENCES} client-side or return template + dependencies
  // 5. Log to audit_log
  return c.json({ message: `TODO: get secret ${name}` }, 501)
})

// POST /api/secrets — create a secret
secretRoutes.post('/', async (c) => {
  const { name, value, envId, isComputed, template } = await c.req.json()
  // TODO:
  // 1. encryptSecret(value, masterKey) → { encryptedValue, wrappedDek }
  // 2. Store encryptedValue in KV: key = "secret:{id}"
  // 3. Store metadata + wrappedDek in D1
  const { encryptedValue, wrappedDek } = await encryptSecret(value, c.env.ENCRYPTION_MASTER_KEY)
  console.log('Encrypted (demo):', encryptedValue.substring(0, 20) + '...')
  return c.json({ message: 'TODO: create secret', name, envId, isComputed }, 501)
})

// PATCH /api/secrets/:id — update a secret value
secretRoutes.patch('/:id', async (c) => {
  return c.json({ message: 'TODO: update secret' }, 501)
})

// DELETE /api/secrets/:id — delete a secret
secretRoutes.delete('/:id', async (c) => {
  return c.json({ message: 'TODO: delete secret' }, 501)
})
