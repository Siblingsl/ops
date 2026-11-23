import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-06 / TL-01（DEV-AI-39）：设置内只读能力清单——
// 域聚合、业务化短名、可用性按角色；不出现 311 条长列表与 path/params；不新增一级导航。
test('DEV-AI-39 FN-06 能力中心设置清单', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-06 能力清单模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  void account
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  // 入口 1：对话页 + 菜单“能力”打开只读 Dialog（P0 验证过的可靠路径）。
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('menuitem', { name: /能力/ }).click()
  const dialog = page.getByRole('dialog', { name: '智能体能力' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toContainText('按业务域列出这个智能体能做什么')
  // 域卡片若干，每个域下能力卡带类型/权限/可用 chip。
  const cards = dialog.locator('li.rounded-lg')
  expect(await cards.count()).toBeGreaterThan(3)
  await expect(dialog.getByText('可用', { exact: true }).first()).toBeVisible()
  // 不出现内部名/路径（38：不泄露 path/params、不给 311 条长列表）。
  const text = await dialog.textContent()
  expect(text ?? '').not.toMatch(/\/api\/v1\//)
  expect(text ?? '').not.toContain('plugin_')
  const domainHeadings = dialog.locator('h3')
  expect(await domainHeadings.count()).toBeLessThan(20)
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-fn06-capabilities-dialog.png') })

  // 入口 2：设置路由已在 registry 登记（桌面设置窗显示“智能体能力”导航项；Web 形态走
  // Routes 分支直接渲染 CapabilitiesSettings，页面数据与 Dialog 同源 TL-01）。
  await page.goto('/settings/capabilities')
  await expect(page.getByRole('button', { name: '智能体能力' })).toBeVisible({ timeout: 15_000 })

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-fn06-capabilities.png') })
  void api
})
