/**
 * Validation-schema tests for the secrets routes.
 *
 * The schemas below mirror those defined in `secrets.ts`. They are reconstructed
 * here (rather than imported) because `secrets.ts` imports the Worker entry
 * (`../index`) at module load, which pulls in runtime-only bindings that cannot
 * be instantiated in a plain Node/Vitest process. Keeping a local copy lets us
 * unit-test the validation contract without a live Worker. If the route schemas
 * change, these must be updated in lockstep.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const secretSchema = z.object({
  projectId: z.string().min(1),
  envId: z.string().min(1),
  name: z.string().min(1).max(128),
  value: z.string().max(65536).optional(),
  isComputed: z.boolean().optional(),
  template: z.string().max(65536).optional(),
})

const createSecretSchema = secretSchema.refine(
  (value) => value.value !== undefined || value.template !== undefined,
  { message: 'Either value or template is required' },
)

const updateSecretSchema = secretSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  })

describe('createSecretSchema', () => {
  it('accepts a valid literal secret', () => {
    const result = createSecretSchema.safeParse({
      projectId: 'prj_1',
      envId: 'env_1',
      name: 'DATABASE_URL',
      value: 'postgres://...',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a computed secret defined by template only', () => {
    const result = createSecretSchema.safeParse({
      projectId: 'prj_1',
      envId: 'env_1',
      name: 'CONN',
      isComputed: true,
      template: '${DB_USER}:${DB_PASS}@host/db',
    })
    expect(result.success).toBe(true)
  })

  it('rejects when neither value nor template is provided', () => {
    const result = createSecretSchema.safeParse({
      projectId: 'prj_1',
      envId: 'env_1',
      name: 'EMPTY',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]!.message).toBe('Either value or template is required')
    }
  })

  it('rejects an empty projectId', () => {
    expect(
      createSecretSchema.safeParse({ projectId: '', envId: 'env_1', name: 'X', value: 'v' }).success,
    ).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(
      createSecretSchema.safeParse({ projectId: 'p', envId: 'e', name: '', value: 'v' }).success,
    ).toBe(false)
  })

  it('rejects a name longer than 128 chars', () => {
    expect(
      createSecretSchema.safeParse({ projectId: 'p', envId: 'e', name: 'a'.repeat(129), value: 'v' }).success,
    ).toBe(false)
  })

  it('rejects a value larger than 65536 chars', () => {
    expect(
      createSecretSchema.safeParse({ projectId: 'p', envId: 'e', name: 'N', value: 'a'.repeat(65537) }).success,
    ).toBe(false)
  })

  it('rejects a non-boolean isComputed', () => {
    expect(
      createSecretSchema.safeParse({ projectId: 'p', envId: 'e', name: 'N', value: 'v', isComputed: 'yes' }).success,
    ).toBe(false)
  })
})

describe('updateSecretSchema', () => {
  it('accepts a single-field update', () => {
    expect(updateSecretSchema.safeParse({ value: 'new-value' }).success).toBe(true)
  })

  it('accepts a name-only rename', () => {
    expect(updateSecretSchema.safeParse({ name: 'RENAMED' }).success).toBe(true)
  })

  it('rejects an empty update object', () => {
    const result = updateSecretSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]!.message).toBe('At least one field must be provided')
    }
  })

  it('still enforces field constraints on partial updates', () => {
    expect(updateSecretSchema.safeParse({ name: 'a'.repeat(129) }).success).toBe(false)
  })
})
