import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('D-131 仅桌面版账号详情显示头条登录入口，并定位到所选账号', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 960, height: 640 })
  const account = await registerAccount(page, '文章', 'toutiao')
  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(page.getByPlaceholder('搜索账号名称或平台')).toBeVisible()
  await expect(page.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  await expect(page.getByText('头条稳定身份与数据读取能力尚未验证。登录后不会自动同步作品，作品仍通过发布包手动发布。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开头条官方登录页', exact: true })).toHaveCount(0)

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    Object.defineProperty(window, '__opsLoginIntents', { configurable: true, value: [] as string[] })
    window.open = (url) => { (window as Window & { __opsLoginIntents: string[] }).__opsLoginIntents.push(String(url)); return null }
  })
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('button', { name: '切换工作区与账号' })).toContainText(account.name)
  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(page.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  const loginButton = page.getByRole('button', { name: '打开头条官方登录页', exact: true })
  await expect(loginButton).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  const bounds = await loginButton.boundingBox()
  expect(bounds).toBeTruthy()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960)
  await loginButton.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('d131-toutiao-login-entry.png'), fullPage: true })
  await loginButton.click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __opsLoginIntents: string[] }).__opsLoginIntents))
    .toContain(`ops-desktop://ui/platform-login/${account.id}/toutiao`)
  await expect.poll(() => page.evaluate(() => (window as Window & { __opsLoginIntents: string[] }).__opsLoginIntents))
    .toContain('ops-desktop://ui/settings/account-device')
})
