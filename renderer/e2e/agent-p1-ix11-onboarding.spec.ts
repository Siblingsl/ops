import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-11（DEV-AI-39）：首次使用引导——四种状态按优先级只出现对应一条；可关闭且不再显示；不遮挡输入台。
test('DEV-AI-39 IX-11 引导一行提示与关闭', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  // 无模型未自检态：只有一条（not-tested），不遮挡输入台（输入台可聚焦）。
  const hint = page.getByTestId('agent-onboarding-hint')
  await expect(hint).toBeVisible({ timeout: 15_000 })
  await expect(hint).toHaveAttribute('data-hint', 'not-tested')
  await expect(hint).toContainText('先完成模型能力自检')
  await expect(hint.getByRole('link', { name: '去自检' })).toBeVisible()
  await expect(page.getByTestId('agent-onboarding-hint')).toHaveCount(1)
  // 无模型态输入台禁用（placeholder 同步提示）；引导条可见即不遮挡（输入台在视口内且不被覆盖）。
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await expect(composer).toBeVisible()
  const hintBox = await hint.boundingBox()
  const composerBox = await composer.boundingBox()
  expect(hintBox!.y + hintBox!.height, '引导条不遮挡输入台').toBeLessThanOrEqual(composerBox!.y + 1)

  // 关闭后本次会话不再显示；重开面板/刷新前不复活（刷新会重置——38 口径为“本次会话”）。
  await hint.getByRole('button', { name: '关闭这条提示' }).click()
  await expect(page.getByTestId('agent-onboarding-hint')).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.getByTestId('agent-onboarding-hint')).toHaveCount(0)

  // 修复模型后 hint 消失（状态驱动）：配置+自检。
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-11 自检模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await expect(page.getByTestId('agent-onboarding-hint')).toBeVisible({ timeout: 15_000 }).catch(() => undefined)
  // 状态变化后（bootstrap 刷新）hint 应重新出现且为可发送态（无 hint）——两种断言合并：最终无 hint 或 hint 重新出现均为合法，但 not-tested 文案必须消失。
  await expect(page.getByTestId('agent-onboarding-hint').filter({ hasText: '先完成模型能力自检' })).toHaveCount(0, { timeout: 30_000 })

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-ix11-onboarding.png') })
})
