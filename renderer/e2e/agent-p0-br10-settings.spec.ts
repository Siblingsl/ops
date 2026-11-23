import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

// BR-10：设置页清理内置浏览数据必须先二次确认，取消不执行、不出现成功提示。
// 真实 Electron 的协议拒绝在 inbrowse-real-electron.spec.ts 验证；这里用 Electron
// UA 的桌面渲染项目验证确认框文案与取消语义（不依赖本机浏览分区）。
test('BR-10 清理浏览 Cookies 与站点数据需二次确认，取消不执行', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const ua = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${ua} Electron/44.8.0` })
  })
  await page.goto('/settings/preferences')
  await expect(page.getByText('浏览数据', { exact: true })).toBeVisible()
  await expect(page.getByText('只清理内置浏览页签的缓存与 Cookies', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: '清理站点数据', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '清理浏览 Cookies 与站点数据？', exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('这些站点需要重新登录')
  await expect(dialog).toContainText('OPS 本身的登录状态不受影响')
  await page.screenshot({ path: '../.playwright-results/agent-p0-br10-clear-confirm.png' })

  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('已清理浏览 Cookies 与站点数据', { exact: true })).toHaveCount(0)
})
