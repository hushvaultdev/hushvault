import { Hono } from 'hono'
import type { Env } from '../index'

export const authRoutes = new Hono<{ Bindings: Env }>()

// POST /api/auth/register
authRoutes.post('/register', async (c) => {
  // TODO: validate email/password, hash password, create user + org
  return c.json({ message: 'TODO: register' }, 501)
})

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  // TODO: validate credentials, issue JWT
  return c.json({ message: 'TODO: login' }, 501)
})

// POST /api/auth/api-keys
authRoutes.post('/api-keys', async (c) => {
  // TODO: generate API key, store HMAC-SHA256 hash
  return c.json({ message: 'TODO: create api key' }, 501)
})

// DELETE /api/auth/api-keys/:id
authRoutes.delete('/api-keys/:id', async (c) => {
  return c.json({ message: 'TODO: revoke api key' }, 501)
})

// POST /api/auth/github-oidc — exchange GitHub OIDC token for HushVault token
authRoutes.post('/github-oidc', async (c) => {
  // TODO: verify GitHub OIDC JWT, issue scoped access token for CI
  return c.json({ message: 'TODO: github oidc exchange' }, 501)
})
