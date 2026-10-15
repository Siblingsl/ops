import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT68 选题状态使用接口响应更新缓存，不重新请求列表', async ({ page }) => {
  const account = await registerAccount(page)
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: 'OPT68 状态缓存验收' })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText(topic.title, { exact: true })).toBeVisible()

  let listRequests = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === `/api/v1/accounts/${account.id}/topics`) listRequests++
  })
  const updated = page.waitForResponse(response => response.url().endsWith(`/api/v1/topics/${topic.id}`) && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: '采用', exact: true }).click()
  expect((await updated).ok()).toBeTruthy()
  await page.getByRole('button', { name: '已采用' }).click()
  await expect(page.getByText(topic.title, { exact: true })).toBeVisible()
  expect(listRequests).toBe(0)
})

test('OPT68 星标立即切换，请求中禁用以阻止重复请求', async ({ page }) => {
  const account = await registerAccount(page)
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: 'OPT68 星标请求验收' })
  let addRequests = 0
  await page.route('**/api/v1/stars', async route => {
    if (route.request().method() === 'POST') {
      addRequests++
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    await route.continue()
  })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText(topic.title, { exact: true })).toBeVisible()
  const star = page.locator('button[aria-pressed]').first()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true', { timeout: 150 })
  await expect(star).toBeDisabled({ timeout: 150 })
  await star.evaluate(button => (button as HTMLButtonElement).click())
  await expect.poll(() => addRequests).toBe(1)
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(star).toBeEnabled()
  expect(addRequests).toBe(1)

  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await expect(star).toBeEnabled()
  await page.route('**/api/v1/stars', async route => {
    if (route.request().method() === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 250))
      await route.fulfill({ status: 500, json: { error: { message: '星标失败模拟' } } })
    } else await route.continue()
  })
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true', { timeout: 150 })
  await expect(star).toHaveAttribute('aria-pressed', 'false')
})

test('OPT68 热点转选题后仅发起两类失效请求', async ({ page }) => {
  const account = await registerAccount(page)
  const matchId = 'opt68-hot-match'
  let converted = false
  const hot = () => ({
    date: '2026-10-13',
    enabled: true,
    paused_sources: [],
    updated_at: '2026-10-13T08:00:00Z',
    items: [{
      id: matchId,
      date: '2026-10-13',
      hot_item: {
        id: 'opt68-hot-item', source_key: 'demo', source_name: '模拟来源', title: 'OPT68 热点转选题验收',
        url: 'https://example.com/hot', rank: 1, heat: '', summary: '', cluster_id: null,
        first_seen_at: '2026-10-13T07:00:00Z', last_seen_at: '2026-10-13T08:00:00Z',
      },
      relevance: 80,
      reason: '与账号方向相关',
      angle: '从日常观察切入',
      risk: [],
      status: converted ? 'converted' : 'new',
      topic_id: converted ? 'opt68-created-topic' : null,
    }],
  })
  await page.route(`**/api/v1/accounts/${account.id}/hot`, route => route.fulfill({ json: hot() }))
  await page.route(`**/api/v1/hot-matches/${matchId}/convert`, async route => {
    converted = true
    await route.fulfill({ json: { topic_id: 'opt68-created-topic' } })
  })
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('button', { name: '转为选题', exact: true })).toBeVisible()

  const actionRequests: string[] = []
  const refreshPaths = new Set([
    `/api/v1/accounts/${account.id}/hot`,
    `/api/v1/accounts/${account.id}/topics`,
    `/api/v1/accounts/${account.id}/references`,
    `/api/v1/accounts/${account.id}/plan`,
    `/api/v1/accounts/${account.id}/daily`,
    `/api/v1/accounts/${account.id}/next-actions`,
    `/api/v1/accounts/${account.id}/dashboard`,
  ])
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === `/api/v1/hot-matches/${matchId}/convert`) actionRequests.push(path)
    else if (request.method() === 'GET' && refreshPaths.has(path)) actionRequests.push(path)
  })
  await page.getByRole('button', { name: '转为选题', exact: true }).click()
  await page.getByLabel('选题标题').fill('OPT68 手动确认的热点选题')
  const convertedResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/hot-matches/${matchId}/convert`))
  await page.getByRole('button', { name: '确认转为选题', exact: true }).click()
  expect((await convertedResponse).ok()).toBeTruthy()
  await expect(page.getByRole('link', { name: '查看选题', exact: true })).toBeVisible()
  expect(actionRequests.length).toBeLessThanOrEqual(2)
})
