import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

async function visibility(page: import('@playwright/test').Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test('OPT27 剩余不到一天时顶栏提示先保存后重新登录', async ({ page }) => {
  await registerAccount(page)
  await page.route('**/api/v1/auth/me', async route => {
    const response = await route.fetch()
    const me = await response.json()
    me.session_expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString()
    await route.fulfill({ response, body: JSON.stringify(me) })
  })
  await page.reload()
  const banner = page.getByRole('status').filter({ hasText: '会话将于' })
  await expect(banner).toContainText('请先保存内容')
  await expect(banner.getByRole('button', { name: '立即续期' })).toBeVisible()
  await expect(banner.getByRole('button', { name: '保存并重新登录' })).toBeVisible()
})

test('GL-06 显式输入密码续期后横幅消失', async ({ page }) => {
  await registerAccount(page)
  await page.route('**/api/v1/auth/me', async route => {
    const response = await route.fetch()
    const me = await response.json()
    me.session_expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString()
    await route.fulfill({ response, body: JSON.stringify(me) })
  })
  await page.reload()
  const banner = page.getByRole('status').filter({ hasText: '会话将于' })
  await expect(banner.getByRole('button', { name: '立即续期' })).toBeVisible()
  await page.unroute('**/api/v1/auth/me')
  await banner.getByRole('button', { name: '立即续期' }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '续期当前会话' }) })
  await dialog.getByPlaceholder('登录密码').fill('local-e2e-password-123')
  const renewed = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/renew') && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '续期 7 天', exact: true }).click()
  expect((await renewed).ok()).toBeTruthy()
  await expect(banner).toHaveCount(0)
  const me = await api(page, 'GET', '/auth/me')
  expect(new Date(me.session_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)
})

test('OPT27 闲置八小时重新聚焦后刷新会话并保存成功', async ({ page }) => {
  await registerAccount(page)
  const workID = await createOutline(page)
  const work = await api(page, 'GET', `/works/${workID}`)
  const section = work.sections[0]
  await page.clock.install()
  let meRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/auth/me') meRequests++
  })
  const before = meRequests

  await visibility(page, true)
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 60 * 60 * 1000))
  await visibility(page, false)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => meRequests).toBeGreaterThan(before)

  const saved = page.waitForResponse(response => response.url().endsWith(`/api/v1/sections/${section.id}`) && response.request().method() === 'PATCH')
  const content = '八小时闲置后重新聚焦，自动保存仍然正常。'
  await page.locator(`#sec-${section.id} textarea`).fill(content)
  await page.clock.runFor(1500)
  expect((await saved).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).sections[0].content_md).toBe(content)
})
