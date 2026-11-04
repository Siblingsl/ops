import { expect, test } from '@playwright/test'
import { api, registerAccount, selectDesktopSetting } from './support'

test('DEV-QA26 G2-13 桌面渲染器回收站读取失败可重试并区分空态', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto(`/a/${account.id}`)
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
  let injectedFailures = 0
  const matchTrash = (url: URL) => url.pathname === '/api/v1/trash'
  await page.route(matchTrash, (route) => {
    injectedFailures++
    return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'qa26 injected failure' } } })
  })
  await selectDesktopSetting(page, '回收站')
  await expect.poll(() => injectedFailures).toBeGreaterThan(0)
  await expect(page.getByRole('alert')).toContainText('加载失败')
  const retry = page.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled({ timeout: 15_000 })
  await page.unroute(matchTrash)
  await retry.click()
  await expect(page.getByText('回收站是空的', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible()
  expect(await api(page, 'GET', '/trash')).toEqual([])
})
