import { test, expect } from '@playwright/test'
import { registerAccount } from './support'

test('OPT23 三十秒内从作品返回工作台不重复请求未变化数据', async ({ page }) => {
  const dashboardRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/v1/accounts/') && pathname.endsWith('/dashboard')) dashboardRequests.push(pathname)
  })
  const account = await registerAccount(page)
  const dashboardPath = '/api/v1/accounts/' + account.id + '/dashboard'
  await expect.poll(() => dashboardRequests.filter((path) => path === dashboardPath).length).toBe(1)

  await page.getByRole('link', { name: '作品', exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/a/' + account.id + '/works')
  await page.getByRole('link', { name: '工作台', exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/a/' + account.id)
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  await page.waitForTimeout(200)

  expect(dashboardRequests.filter((path) => path === dashboardPath)).toHaveLength(1)
})
