import { test, expect } from '@playwright/test'
import { registerAccount } from './support'

test('OPT09 非工作台页面用轻量用量，工作台只读推荐而运营页准备', async ({ page }) => {
  const account = await registerAccount(page)
  const requests: URL[] = []
  page.on('request', request => { if (request.method() === 'GET') requests.push(new URL(request.url())) })
  for (const path of [`/a/${account.id}/topics`, `/a/${account.id}/materials`, '/settings/usage']) {
    requests.length = 0
    const status = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/ai/status')
    await page.goto(path)
    const usage = await (await status).json()
    expect(typeof usage.tokens_today).toBe('number')
    await expect(page.getByTitle('查看 AI 用量')).toContainText('今日')
    expect(requests.filter(url => url.pathname.endsWith('/dashboard'))).toHaveLength(0)
    expect(requests.filter(url => url.pathname.endsWith('/daily'))).toHaveLength(0)
  }
  requests.length = 0
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  await expect(page.getByText('还没有今日推荐', { exact: true })).toBeVisible()
  const daily = requests.filter(url => url.pathname.endsWith('/daily'))
  expect(daily.length).toBeGreaterThan(0)
  for (const request of daily) expect(request.searchParams.get('prepare')).toBe('false')
  const opened = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/daily') && !new URL(request.url()).searchParams.has('prepare'))
  await page.goto(`/a/${account.id}/ops`)
  await opened
})
