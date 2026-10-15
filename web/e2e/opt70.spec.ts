import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT70 普通错误提示至少显示八秒', async ({ page }) => {
  await registerAccount(page)
  await page.clock.install()
  await page.route('**/api/v1/inbox', route => route.fulfill({
    status: 500,
    json: { error: { code: 'internal', message: '模拟收件箱保存失败' } },
  }))
  await page.getByTitle(/记一条灵感/).click()
  await page.getByPlaceholder('一句话也行：看到的、想到的、被问到的…').fill('用于提示时长验收的灵感')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const error = page.locator('[data-sonner-toast]').filter({ hasText: '模拟收件箱保存失败' })
  await expect(error).toBeVisible()
  await page.clock.fastForward(7_999)
  await expect(error).toBeVisible()
})

test('OPT70 带重试操作的 AI 错误提示不自动消失', async ({ page }) => {
  const account = await registerAccount(page)
  await page.clock.install()
  await page.route(`**/api/v1/accounts/${account.id}/topics/suggest`, route => route.fulfill({
    status: 500,
    json: { error: { code: 'internal', message: '模拟选题建议失败' } },
  }))
  await page.goto(`/a/${account.id}/topics`)
  await page.getByRole('button', { name: 'AI 选题建议' }).first().click()
  await page.getByPlaceholder('方向关键词（可选），例如：时间管理').fill('内容运营')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const error = page.locator('[data-sonner-toast]').filter({ hasText: '生成选题建议失败' })
  await expect(error).toBeVisible()
  await expect(error.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await page.clock.fastForward(60_000)
  await expect(error).toBeVisible()
})
