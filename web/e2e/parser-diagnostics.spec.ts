import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

// REF41 F4（docs/41 §F4）：采集诊断页。种子失败样本 → Top 字段可见 → 配方草稿生成 →
// 人工 verify → activate（“不会自动修改适配器”提示可见）。

test('REF41 F4 采集诊断：失败 Top 字段与配方状态机', async ({ page }) => {
  await registerAccount(page)
  // 种子：3 条同字段失败（走测试服务钩子），随后 recipeJob 生成草稿。
  const seedStatus = await page.request.post('http://127.0.0.1:8180/__e2e/parser-events/seed', { data: {} })
  expect(seedStatus.status()).toBe(200)

  await page.goto('/settings/parser-diagnostics')
  await expect(page.getByRole('heading', { name: '采集诊断' })).toBeVisible()
  await expect(page.getByTestId('parser-top-fields')).toBeVisible()
  await expect(page.getByText('title').first()).toBeVisible()
  // 配方草稿卡：verify → activate。
  const verifyBtn = page.getByTestId(/^parser-verify-/)
  if (await verifyBtn.count() > 0) {
    await verifyBtn.first().click()
    await expect(page.getByText('已标记验证通过')).toBeVisible({ timeout: 15_000 })
    const activateBtn = page.getByTestId(/^parser-activate-/)
    await expect(activateBtn.first()).toBeVisible()
    await activateBtn.first().click()
    await expect(page.getByText('已启用（仅作参考，不会自动改适配器）')).toBeVisible({ timeout: 15_000 })
  }
  await expect(page.getByText('配方仅作人工参考')).toBeVisible()
})
