import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('NW-F1 新建面板可选模板，模板决定形态并显示结构', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(panel).toBeVisible()

  const templateSelect = panel.getByRole('combobox', { name: /模板（可选）/ })
  await expect(templateSelect.locator('option', { hasText: '观点文（内置）' })).toHaveCount(1)
  await templateSelect.selectOption({ label: '观点文（内置）' })
  await expect(panel.getByText(/提出观点 → 论据一/)).toBeVisible()

  const created = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${account.id}/works`) && r.request().method() === 'POST')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  const work = await (await created).json()
  await page.waitForURL(new RegExp(`/works/${work.id}$`))
  expect(work.content_format).toBe('long_article')
  expect(work.template_id).toBeTruthy()
})
