import { test, expect } from '@playwright/test'

test('会话服务异常时保留页面并允许重试，未登录时才跳转', async ({ page }) => {
  let calls = 0
  await page.route('**/api/v1/auth/status', route => route.fulfill({ json: { needs_setup: false } }))
  await page.route('**/api/v1/auth/me', route => {
    calls++
    return route.fulfill(calls === 1
      ? { status: 500, json: { error: { code: 'internal', message: '服务器内部错误，请稍后重试' } } }
      : { status: 401, json: { error: { code: 'unauthenticated', message: '请先登录' } } })
  })
  await page.goto('/settings/accounts')
  await expect(page.getByText('无法确认登录状态')).toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page).toHaveURL(/\/login/)
})

test('服务恢复后可重试原设置页面', async ({ page }) => {
  const username = `session-retry-${Date.now()}`
  const registration = await page.request.post('/api/v1/auth/register', { data: { username, password: 'local-e2e-password-123' } })
  expect(registration.ok()).toBeTruthy()
  let attempts = 0
  await page.route('**/api/v1/auth/me', route => {
    attempts++
    return attempts === 1
      ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: '服务暂不可用' } } })
      : route.continue()
  })
  await page.goto('/settings/accounts')
  await expect(page.getByText('无法确认登录状态')).toBeVisible()
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('无法确认登录状态')).not.toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)
})
