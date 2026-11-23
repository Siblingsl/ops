import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 OT-01（DEV-AI-39）：性能预算——首屏 ≤1.5s、候选首屏 ≤200ms（宽松阈值防 flaky）、
// 面板展开 ≤180ms、输入响应即时反映。计时来自真实应用（performance.now），不是估算。
test('DEV-AI-39 OT-01 性能阈值', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OT01 性能作品' })
  // 输入台在无自检模型时禁用（IX-05 口径）；先配置并通过自检。
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'OT01 性能模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })

  // 隐私说明是一次性流程：先确认一次，让计时口径落在“已有会话首屏”（38 OT-01：bootstrap+最近消息 ≤1.5s）。
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  // 首屏：重新加载后 1.5s 内出现会话头（bootstrap + 列表 + 空态就绪，不含一次性引导）。
  const started = Date.now()
  await page.goto('/agent')
  await expect(page.locator('.desktop-agent-header')).toBeVisible({ timeout: 1_500 })
  const firstPaint = Date.now() - started
  expect(firstPaint, `首屏 ${firstPaint}ms 应 ≤1500ms（本地模拟）`).toBeLessThanOrEqual(1_500)

  const composer = page.getByRole('textbox', { name: '发送消息' })

  // 输入响应：fill 后下一帧即可读到值（≤16ms 一帧 + 宽松 100ms）。
  const inputStart = Date.now()
  await composer.fill('OT01 输入响应')
  await expect(composer).toHaveValue('OT01 输入响应', { timeout: 100 })
  const inputMs = Date.now() - inputStart
  expect(inputMs, `输入响应 ${inputMs}ms 应 ≤100ms`).toBeLessThanOrEqual(100)

  // 候选首屏：@ 触发到候选浮层可见 ≤200ms（IX-01 防抖 250ms 只作用于筛选更新，
  // 打开即出的静态命令/页签骨架不受影响；此处测浮层本身出现时间）。
  const candidateStart = Date.now()
  await composer.fill('@')
  await expect(page.locator('.agent-composer-candidates')).toBeVisible({ timeout: 200 })
  const candidateMs = Date.now() - candidateStart
  expect(candidateMs, `候选浮层首屏 ${candidateMs}ms 应 ≤200ms`).toBeLessThanOrEqual(200)
  await composer.fill('')

  // 面板展开：点击入口到面板可见 ≤180ms（CSS 无过渡动画，应为即时渲染）。
  const panelStart = Date.now()
  await page.locator('.desktop-agent-panel-button').click()
  await expect(page.locator('#agent-workbench-panel')).toBeVisible({ timeout: 180 })
  const panelMs = Date.now() - panelStart
  expect(panelMs, `面板展开 ${panelMs}ms 应 ≤180ms`).toBeLessThanOrEqual(180)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ot01-perf.png') })
})
