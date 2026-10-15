import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT73 创建账号名称校验显示在名称字段下方', async ({ page }) => {
  await registerAccount(page)
  let createRequests = 0
  await page.route('**/api/v1/accounts', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    createRequests++
    await route.fulfill({ status: 422, json: {
      error: { code: 'validation_failed', message: '请完善账号信息', fields: { name: '请填写账号名称' } },
    } })
  })
  await page.goto('/settings/accounts?new=1')
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(dialog.getByText('请填写账号名称', { exact: true })).toBeVisible()
  expect(createRequests).toBe(1)
})
