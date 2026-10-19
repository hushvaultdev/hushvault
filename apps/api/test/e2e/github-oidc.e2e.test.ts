// GitHub OIDC pull end-to-end.
// Negative path always runs (asserts /api/auth/github-oidc rejects a non-matching token).
// Positive path is skipped unless HUSHVAULT_E2E_OIDC_PRIVATE_JWK + HUSHVAULT_E2E_OIDC_KID are set
// in env.local — the only honest positive is a real GitHub Actions runner (follow-up to this plan).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, createProjectAndEnv, makeRunId, registerThrowawayUser, teardownAccount } from './_helpers'

describe('[github-oidc] authorise a CI pull against a HushVault environment', () => {
  const runId = makeRunId()
  let user: Awaited<ReturnType<typeof registerThrowawayUser>>
  let projectId = ''
  let envId = ''

  beforeAll(async () => {
    user = await registerThrowawayUser({ runId })
    const made = await createProjectAndEnv(user.token, runId)
    projectId = made.projectId
    envId = made.envId
  })

  afterAll(async () => {
    if (user) await teardownAccount(user.token, user.password)
  })

  it('registers a repo rule for a dummy repo + ref', async () => {
    const repo = process.env.HUSHVAULT_E2E_GITHUB_REPO ?? 'hushvaultdev/hushvault'
    const res = await api('/api/ci-access/github/rules', {
      method: 'POST',
      token: user.token,
      json: { repo, envId, ref: 'refs/heads/main' },
    })
    // Some older deploys use 201; some 200. Accept either.
    expect([200, 201]).toContain(res.status)
    expect(res.body).toBeTruthy()
    // Keep projectId referenced so the test shape stays stable if we add more assertions.
    expect(projectId).toBeTruthy()
  })

  it('/api/auth/github-oidc rejects a bogus / unsigned token', async () => {
    const res = await api('/api/auth/github-oidc', {
      method: 'POST',
      json: { token: 'not.a.jwt', envId },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const body = res.body as { error?: string }
    expect(body.error).toBeDefined()
  })

  const hasFixture = Boolean(process.env.HUSHVAULT_E2E_OIDC_PRIVATE_JWK && process.env.HUSHVAULT_E2E_OIDC_KID)
  it.skipIf(!hasFixture)('positive OIDC path returns a CI token and reads the resolved env', async () => {
    // Intentionally not implemented — the only honest positive path is a real GitHub Actions runner,
    // tracked as a follow-up to this plan. If the user ships an OIDC fixture here later, this test
    // should mint a signed id_token with the stored key, exchange it, and call /environments/:id/resolved.
    // Keep this skip-with-reason until that fixture is in place.
    expect.fail('OIDC fixture detected but positive path not yet implemented — see follow-up issue')
  })
})
