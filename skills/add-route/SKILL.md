# Add Route Skill

Add a new Hono API route to HushVault following all conventions.

## When to Use

Use `/add-route [resource] [method] [description]` when adding new API endpoints.

Example: `/add-route tokens GET "list API tokens for a project"`

## Steps

### 1. Identify the Route File

Check if a route file already exists for this resource:
```bash
ls apps/api/src/routes/
```

If it doesn't exist, create `apps/api/src/routes/[resource].ts`.

### 2. Define the Zod Schema

At the top of the route file, define request/response schemas:

```typescript
import { z } from 'zod'

const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().datetime().optional(),
})
```

### 3. Add the Route Handler

Follow the standard pattern:

```typescript
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/d1'
import { nanoid } from 'nanoid'
import { requireAuth } from '../middleware/auth.js'
import type { Env } from '../index.js'

const router = new Hono<{ Bindings: Env }>()

router.get('/', requireAuth, async (c) => {
  const db = drizzle(c.env.DB)
  const user = c.get('user')

  const results = await db.select().from(tokens).where(eq(tokens.userId, user.id)).all()

  return c.json({ data: results })
})

router.post('/', requireAuth, zValidator('json', createTokenSchema), async (c) => {
  const db = drizzle(c.env.DB)
  const user = c.get('user')
  const { name, expiresAt } = c.req.valid('json')

  const created = await db.insert(tokens).values({
    id: nanoid(),
    userId: user.id,
    name,
    expiresAt: expiresAt ?? null,
    createdAt: new Date().toISOString(),
  }).returning().get()

  return c.json({ data: created }, 201)
})

export { router as tokensRouter }
```

### 4. Mount in index.ts

In `apps/api/src/index.ts`:
```typescript
import { tokensRouter } from './routes/tokens.js'

app.route('/api/tokens', tokensRouter)
```

### 5. Add to Schema (if new table needed)

See `/db-migrate` skill for creating migrations.

### 6. Update API Docs

Add the endpoint to `docs/API.md`.

### 7. Write Tests

Create `apps/api/src/routes/[resource].test.ts` with at least:
- Happy path (201/200 with valid input)
- Auth failure (401 with no token)
- Validation failure (400 with invalid input)
- Not found (404 for unknown ID)

## Error Response Reference

```typescript
return c.json({ error: 'NOT_FOUND', message: 'Token not found' }, 404)
return c.json({ error: 'UNAUTHORIZED', message: 'Invalid token' }, 401)
return c.json({ error: 'FORBIDDEN', message: 'Access denied' }, 403)
return c.json({ error: 'VALIDATION_ERROR', message: 'Name is required' }, 400)
return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' }, 500)
```
