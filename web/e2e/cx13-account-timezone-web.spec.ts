import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-CXEF-07：账号时区 UI 编辑入口（Web 浏览器形态）。
// 与桌面端互补：这里验证「整档案 PUT 不清空既有字段」+「非法时区 422 不落库」。
test('CF-P2-CXEF-07 Web 账号时区保存后刷新仍在，且整档案字段不被清空', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-tz-web-${Date.now()}`)

  // 先播种一份完整档案，用于验证 UI 的整档案 PUT 不会把已有字段清空。
  await api(page, 'PUT', `/accounts/${account.id}/profile`, {
    positioning_tags: ['职场'], target_audience: '一线运营', persona_tone: '冷静克制',
    banned_words: [], style_summary: '结论先行', default_theme: 'ink',
    wechat_defaults: { author: '阿砚', open_comment: false, fans_only_comment: false, source_url: '' },
    timezone: 'Asia/Shanghai',
  })
  await page.goto(`/a/${account.id}/profile?tab=positioning`)

  const input = page.getByLabel('账号时区')
  await expect(input).toHaveValue('Asia/Shanghai')
  await input.fill('Pacific/Honolulu')
  await page.getByRole('button', { name: '保存档案' }).click()

  // 刷新后仍在：值来自服务端 GET，而不是组件本地 state。
  await page.reload()
  await expect(page.getByLabel('账号时区')).toHaveValue('Pacific/Honolulu')
  const saved = await api(page, 'GET', `/accounts/${account.id}/profile`) as {
    timezone: string
    target_audience: string
    style_summary: string
    wechat_defaults: { author: string }
  }
  expect(saved.timezone).toBe('Pacific/Honolulu')
  expect(saved.target_audience).toBe('一线运营')
  expect(saved.style_summary).toBe('结论先行')
  expect(saved.wechat_defaults.author).toBe('阿砚')

  // 非法 IANA 时区：服务端 422 中文提示内联显示，且不落库。
  await page.getByLabel('账号时区').fill('Not/A_Zone')
  await page.getByRole('button', { name: '保存档案' }).click()
  await expect(page.getByText(/账号时区须为有效 IANA 时区名/)).toBeVisible()
  const after = await api(page, 'GET', `/accounts/${account.id}/profile`) as { timezone: string }
  expect(after.timezone).toBe('Pacific/Honolulu')
})
