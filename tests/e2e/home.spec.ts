import { test, expect } from '@playwright/test'

test('marketing homepage loads and shows features', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/HushVault/)
  await expect(page.getByText('Computed secrets', { exact: true })).toBeVisible()
  await expect(page.getByText('Branch inheritance', { exact: true })).toBeVisible()
  await expect(page.getByText('Cloudflare-native sync', { exact: true })).toBeVisible()
})

test('faq page is reachable from marketing docs route', async ({ page }) => {
  await page.goto('/faq')
  await expect(page.locator('text=Frequently asked questions')).toBeVisible()
  await expect(page.locator('text=How did HushVault start?')).toBeVisible()
})
