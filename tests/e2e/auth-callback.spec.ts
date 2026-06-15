import { test, expect } from '@playwright/test'

// The OAuth callback renders client-side from the URL fragment; an error
// fragment should surface a friendly message and a way back. No API needed.
test('oauth callback shows an error message for a denied sign-in', async ({ page }) => {
  await page.goto('/auth/callback#error=github_denied')
  await expect(page.getByRole('heading', { name: 'Sign-in failed' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible()
})
