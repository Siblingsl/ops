import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-CXEF-07：账号时区 UI 编辑入口（桌面工作台形态）。
// 与 Web 端互补：这里验证 datalist 常用时区清单 + 失败后服务端值保持不变。
// 浏览器形态同段旅程见 web/e2e/cx13-account-timezone-web.spec.ts（不同名，各自独立）。
test('CF-P2-CXEF-07 桌面账号时区候选清单、持久化与非法时区拒绝', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  // 桌面注册即建 xhs 账号；用户名前缀与浏览器旅程区分。
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-tz-desktop-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile?tab=positioning`)

  const input = page.getByLabel('账号时区')
  await expect(input).toHaveValue('Asia/Shanghai')
  const options = page.locator('datalist#account-timezone-options option')
  await expect(options).toHaveCount(11)
  await expect(page.locator('datalist#account-timezone-options option[value="Asia/Shanghai"]')).toHaveCount(1)
  await expect(page.locator('datalist#account-timezone-options option[value="America/New_York"]')).toHaveCount(1)
  await expect(page.locator('datalist#account-timezone-options option[value="Pacific/Honolulu"]')).toHaveCount(1)

  await input.fill('America/New_York')
  await page.getByRole('button', { name: '保存档案' }).click()
  await page.reload()
  await expect(page.getByLabel('账号时区')).toHaveValue('America/New_York')
  const saved = await api(page, 'GET', `/accounts/${account.id}/profile`) as { timezone: string }
  expect(saved.timezone).toBe('America/New_York')

  // 非法时区：字段内联显示服务端 422 中文提示，服务端档案不被改写。
  await page.getByLabel('账号时区').fill('Mars/Olympus')
  await page.getByRole('button', { name: '保存档案' }).click()
  await expect(page.getByText(/账号时区须为有效 IANA 时区名/)).toBeVisible()
  const after = await api(page, 'GET', `/accounts/${account.id}/profile`) as { timezone: string }
  expect(after.timezone).toBe('America/New_York')
})
