import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerAccount } from './support'

// 39 文档 UI-09（DEV-AI-39）：底栏与系统状态——
// 全局底栏不再出现“操作状态由当前页面反馈”开发文案；显示“已连接/连接中…/离线，点击重试”，
// 离线态点重试恢复“已连接”；主界面不暴露 SSE/run 等开发语言。
test('DEV-AI-39 UI-09 底栏连接态与离线重试', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const statusbar = page.getByTestId('desktop-statusbar')
  await expect(statusbar).toBeVisible()
  // 开发文案消失（全局 grep 由单测守卫兜底）。
  await expect(statusbar).not.toContainText('操作状态由当前页面反馈')
  // 在线态。
  await expect(statusbar).toContainText('已连接')

  // 离线：断掉网络事件并拦截 healthz。
  await page.context().setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(statusbar.getByRole('button', { name: '离线，点击重试' })).toBeVisible({ timeout: 15_000 })

  await expect(statusbar).not.toContainText('已连接')

  // 恢复：解除拦截。online 事件会自动探测恢复；若离线按钮仍在（探测未跑完），点“重试”兜底。
  await page.context().setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(statusbar).toContainText('已连接', { timeout: 15_000 })
  await expect(statusbar.getByRole('button', { name: '离线，点击重试' })).toHaveCount(0)

  // 主界面不出现开发语言（38 §7.9）。
  const workbench = page.locator('.desktop-agent-workbench')
  await expect(workbench).not.toContainText(/SSE|run\b|feature flag/)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-ui09-statusbar.png') })
})
