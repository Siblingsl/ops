import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('网页端自定义主题校验旧颜色并允许保存修正', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const legacyTheme = {
    base: 'ink', primary_color: '#999999', font_size: 16, line_height: 1.8,
    paragraph_gap: 18, heading_style: 'underline', quote_style: 'bar',
  }
  let legacyRead = true
  await page.route(`**/api/v1/accounts/${account.id}/custom-theme`, async route => {
    if (legacyRead && route.request().method() === 'GET') {
      legacyRead = false
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(legacyTheme) })
      return
    }
    await route.continue()
  })
  await page.goto(`/a/${account.id}/profile?tab=layout`)
  const card = page.locator('div').filter({ has: page.getByText('我的主题', { exact: true }) }).filter({ has: page.getByRole('button', { name: '保存并设为默认主题' }) }).last()
  await expect(card.locator('input.font-mono')).toHaveValue('#999999')
  await expect(card.getByRole('alert')).toContainText('对比度不足')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  expect(await api(page, 'GET', `/accounts/${account.id}/custom-theme`)).toBeNull()
  await card.locator('input.font-mono').fill('#2F5D62')
  await expect(card.getByRole('alert')).toHaveCount(0)
  const response = page.waitForResponse(r => r.url().endsWith('/custom-theme') && r.request().method() === 'PUT')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.reload()
  await expect(card.locator('input.font-mono')).toHaveValue('#2F5D62')
})
