import { expect, test } from '@playwright/test'
import { createOutline, registerAccount } from './support'

test('CX11 浏览器大纲生成展示服务端来源回执与缺项', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await createOutline(page)

  await expect(page.locator('#step-title')).toBeVisible()
  await expect(page.locator('#step-viewpoint')).toBeVisible()
  const basisSummary = page.getByRole('button', { name: /创作依据/ }).first()
  await expect(basisSummary).toBeVisible()
  await basisSummary.click()

  await expect(page.getByText('创作依据', { exact: true })).toBeVisible()
  await expect(page.getByText(new RegExp(`profile · ${account.id}`))).toBeVisible()
  await expect(page.getByText(/material：本次没有选入可用素材/)).toBeVisible()
  await expect(page.getByText(/输入版本 [a-f0-9]{16}/)).toBeVisible()
  await expect(page.getByText(/任务：outline · 模型：.+ · 提示词版本：1 · 状态：ok/)).toBeVisible()
})
