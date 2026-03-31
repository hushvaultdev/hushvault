---
description: Hono API design conventions for route handlers, middleware, and error responses
globs:
  - "apps/api/src/routes/**/*.ts"
  - "apps/api/src/middleware/**/*.ts"
  - "apps/api/src/index.ts"
---

# Hono API Design Rules

## Route File Structure

Each route file exports a named Hono router:

```typescript
import { Hono } from 'hono'
import type { Env } from '../index.js'

const router = new Hono<{ Bindings: Env }>()

router.get('/:id', async (c) => {
  const { id } = c.req.param()
  const db = drizzle(c.env.DB)
  // ...
  return c.json({ data: result })
})

export { router as thingRouter }
```

## Naming Conventions

- Route files: `apps/api/src/routes/[resource].ts` (e.g., `secrets.ts`, `projects.ts`)
- Router exports: `[resource]Router` (e.g., `secretsRouter`)
- Mounted in `apps/api/src/index.ts` under `/api/[resource]`

## Standard Response Shapes

```typescript
// Success
return c.json({ data: result })
return c.json({ data: results, total: count })

// Created
return c.json({ data: created }, 201)

// Error
return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
return c.json({ error: 'UNAUTHORIZED', message: 'Invalid token' }, 401)
return c.json({ error: 'VALIDATION_ERROR', message: 'Key is required' }, 400)
return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' }, 500)
```

Error codes are SCREAMING_SNAKE_CASE. Messages are human-readable. Never expose stack traces, DB errors, or internal state in production responses.

## Authentication

All protected routes must call `requireAuth(c)` middleware first:

```typescript
import { requireAuth } from '../middleware/auth.js'

router.get('/', requireAuth, async (c) => {
  const user = c.get('user')  // typed from middleware
  // ...
})
```

## Input Validation

Use Zod schemas defined at the top of each route file:

```typescript
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const createSecretSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().max(65536),
})

router.post('/', zValidator('json', createSecretSchema), async (c) => {
  const { key, value } = c.req.valid('json')
  // ...
})
```

## ID Generation

Use `nanoid()` for all record IDs. Never auto-increment integers (leaks record count).

```typescript
import { nanoid } from 'nanoid'
const id = nanoid()
```
