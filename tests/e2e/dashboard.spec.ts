import { test, expect } from '@playwright/test'

// The dashboard auth guard runs client-side: with no stored session it
// redirects to /sign-in. This needs no API, so it is safe to run in CI.
test('unauthenticated users are redirected from the dashboard to sign-in', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign in to HushVault' })).toBeVisible()
})

// Every authenticated dashboard route is behind the same guard.
for (const route of ['/onboarding', '/integrations', '/audit', '/billing']) {
  test(`unauthenticated users are redirected from ${route} to sign-in`, async ({ page }) => {
    await page.goto(route)
    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(page.getByRole('heading', { name: 'Sign in to HushVault' })).toBeVisible()
  })
}
