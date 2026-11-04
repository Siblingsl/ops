import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

function localDate(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

async function makeNoPermissionPresentation(page: Page, accountID: string) {
  await page.route('**/api/v1/accounts*', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/accounts') return route.continue()
    const response = await route.fetch()
    const accounts = await response.json() as Array<{ id: string; datacube_state?: string }>
    const account = accounts.find((row) => row.id === accountID)
    if (!account) throw new Error('E2E 账号未出现在账号列表中')
    account.datacube_state = 'no_permission'
    await route.fulfill({ response, json: accounts })
  })
  await page.route(`**/api/v1/accounts/${accountID}/followers*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const followers = await response.json() as { api: boolean }
    followers.api = false
    await route.fulfill({ response, json: followers })
  })
}

test('DEV-QA26 G6 Web 粉丝同步、权限提示与手动回退', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API')
  test.setTimeout(240_000)

  const username = `qa26-g6-followers-web-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username) as { id: string }
  const accountPath = `/accounts/${account.id}`
  await api(page, 'PUT', `${accountPath}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-wechat-secret' })
  const capability = await api(page, 'POST', `${accountPath}/wechat-credential/test`) as { ok: boolean; datacube_state: string }
  expect(capability).toMatchObject({ ok: true, datacube_state: 'ok' })

  await page.goto(`/a/${account.id}/review`)
  await expect(page.getByRole('heading', { name: '数据复盘', exact: true })).toBeVisible()
  let syncRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`${accountPath}/metrics/sync-wechat`)) syncRequests++
  })
  const syncResponse = page.waitForResponse((response) => response.url().includes(`${accountPath}/metrics/sync-wechat`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '同步公众号数据', exact: true }).click()
  const response = await syncResponse
  expect(response.ok()).toBeTruthy()
  const result = await response.json() as { result: { days: number; follower_days: number }; message: string }
  expect(result.result).toMatchObject({ days: 7, follower_days: 7 })
  expect(result.message).toContain('账号粉丝数据 7 天')

  const followers = await api(page, 'GET', `${accountPath}/followers?days=30`) as { api: boolean; days: Array<{ date: string; source: string }> }
  expect(followers.api).toBe(true)
  expect(followers.days).toHaveLength(7)
  expect(followers.days.every((row) => row.source === 'wechat_api')).toBe(true)
  const section = page.locator('#review-followers')
  await expect(section.getByRole('heading', { name: /账号粉丝变化/ })).toBeVisible()
  await expect(section.getByText('公众号接口', { exact: true })).toHaveCount(7)

  // 只覆盖界面权限分支；底层 no_permission/403 与部分粉丝失败由 DR03/DR09 Go 集成测试验证。
  await makeNoPermissionPresentation(page, account.id)
  await page.reload()
  await expect(page.getByText(/当前公众号没有数据统计接口权限/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '同步公众号数据', exact: true })).toHaveCount(0)
  await expect.poll(() => syncRequests).toBe(1)

  const restrictedSection = page.locator('#review-followers')
  await restrictedSection.getByRole('button', { name: '补录一天', exact: true }).click()
  await expect(restrictedSection.getByText('当前公众号没有数据统计接口权限，可以从后台抄录每天的关注数据')).toBeVisible()
  const enteredDate = new Date()
  enteredDate.setDate(enteredDate.getDate() - 20)
  const manualDate = localDate(enteredDate)
  await restrictedSection.getByLabel('日期').fill(manualDate)
  await restrictedSection.getByLabel('新增关注').fill('3')
  await restrictedSection.getByLabel('取消关注').fill('1')
  await restrictedSection.getByLabel('粉丝总数').fill('100')
  const manualSave = page.waitForResponse((r) => r.url().includes(`${accountPath}/followers`) && r.request().method() === 'POST')
  await restrictedSection.getByRole('button', { name: '保存', exact: true }).click()
  expect((await manualSave).ok()).toBeTruthy()
  const persisted = await api(page, 'GET', `${accountPath}/followers?days=30`) as { days: Array<{ date: string; source: string; new_follow: number | null }> }
  expect(persisted.days).toHaveLength(8)
  expect(persisted.days.find((row) => row.date === manualDate)).toMatchObject({ source: 'manual', new_follow: 3 })
})

test('DEV-QA26 G6 Web 每日同步开关保存重载与20次延迟样本', async ({ page }, testInfo) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API')
  test.setTimeout(180_000)

  const username = `qa26-g6-daily-toggle-web-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username) as { id: string }
  const accountPath = `/accounts/${account.id}`
  await api(page, 'PUT', `${accountPath}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-wechat-secret' })
  const capability = await api(page, 'POST', `${accountPath}/wechat-credential/test`) as { ok: boolean; datacube_state: string }
  expect(capability).toMatchObject({ ok: true, datacube_state: 'ok' })
  const initial = await api(page, 'GET', accountPath) as { metrics_wechat_auto: { enabled: boolean } }
  expect(initial.metrics_wechat_auto.enabled).toBe(true)

  await page.goto(`/a/${account.id}/review`)
  await expect(page.getByRole('heading', { name: '数据复盘', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^用户菜单/ }).click()
  await page.getByRole('menuitem', { name: '平台账号与凭证', exact: true }).click()
  await expect(page.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
  const toggle = page.getByRole('switch', { name: '数据接口每日同步', exact: true })
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  const latencies: number[] = []
  for (let i = 0; i < 20; i++) {
    const expected = i % 2 !== 0
    const update = page.waitForResponse((response) => response.url().includes(`${accountPath}`) && response.request().method() === 'PATCH')
    const started = performance.now()
    await toggle.click()
    const response = await update
    expect(response.ok()).toBeTruthy()
    await expect(toggle).toHaveAttribute('aria-checked', String(expected))
    latencies.push(performance.now() - started)
    const persisted = await api(page, 'GET', accountPath) as { metrics_wechat_auto: { enabled: boolean } }
    expect(persisted.metrics_wechat_auto.enabled).toBe(expected)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  console.log(`DEV-QA26 G6 Web 每日同步开关：样本=${latencies.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms failures=0`)
  await testInfo.attach('g6-daily-sync-toggle-latencies', { body: JSON.stringify({ samples: latencies, p50, p95, failures: 0 }), contentType: 'application/json' })

  await page.reload()
  await expect(page.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '数据接口每日同步', exact: true })).toHaveAttribute('aria-checked', 'true')
  const afterReload = await api(page, 'GET', accountPath) as { metrics_wechat_auto: { enabled: boolean } }
  expect(afterReload.metrics_wechat_auto.enabled).toBe(true)
})
