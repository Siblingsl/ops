import { test, expect } from '@playwright/test'

test('服务异常不应当成会话失效', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/v1/auth/status', route => route.fulfill({ json: { needs_setup: false } }))
  await page.route('**/api/v1/auth/me', route => {
    attempts += 1
    return route.fulfill(attempts === 1
      ? { status: 500, json: { error: { code: 'internal', message: '服务器内部错误，请稍后重试' } } }
      : { status: 401, json: { error: { code: 'unauthenticated', message: '请先登录' } } })
  })
  await page.goto('/settings/accounts')
  await expect(page.getByText('无法确认登录状态')).toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page).toHaveURL(/\/login/)
})

test('登录状态读取失败后可以在原页面重试', async ({ page }) => {
  const registration = await page.request.post('/api/v1/auth/register', {
    data: { username: `auth-retry-${Date.now()}`, password: 'local-e2e-password-123' },
  })
  expect(registration.ok()).toBeTruthy()
  let attempts = 0
  await page.route('**/api/v1/auth/me', route => {
    attempts += 1
    if (attempts > 1) return route.continue()
    return route.fulfill({ status: 500, json: { error: { code: 'internal', message: '服务暂不可用' } } })
  })
  await page.goto('/settings/accounts')
  await expect(page.getByText('无法确认登录状态')).toBeVisible()
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('无法确认登录状态')).not.toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)
})
