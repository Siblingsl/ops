import { test, expect, type Page } from '@playwright/test'
import { preferDesktopAccount, registerAccount } from './support'

async function setup(page: Page) {
  const account = await registerAccount(page)
  await preferDesktopAccount(page, account.id)
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { get: () => `${agent} Electron/44.8.0` })
    Object.defineProperty(window, 'opsDesktopUI', { value: {
      onOpenSettings: () => () => undefined,
      onLocalSettingsState: () => () => undefined,
      onPlatformIntentResult: () => () => undefined,
    } })
  })
  const now = new Date().toISOString()
  await page.route('**/api/v1/platform-collection/policy', route => route.fulfill({ json: {
    global_enabled: true, account_sync_platforms: ['xhs'], metrics_refresh_platforms: ['xhs'], policy: { enabled: true },
  } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-connection`, route => route.fulfill({ json: { connection: {
    id: 'sync-details-connection', account_id: account.id, platform: 'xhs', is_holder: true, state: 'active',
    availability: 'ready', external_account_key: 'xhs_user_id:details-fixture', last_seen_at: now,
    authorization_revision: 1, sync_capabilities: { catalog: 'supported', content: 'unknown', metrics: 'supported' },
  } } }))
  await page.route(`**/api/v1/accounts/${account.id}/metrics/observations`, route => route.fulfill({ json: { observations: [] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-profile`, route => route.fulfill({ json: { snapshot: null } }))
  const operation = { id: 'details-operation', account_id: account.id, kind: 'account_sync', revision: 1,
    status: 'partial', stage: 'complete', counters: { discovered: 2 }, coverage: {}, available_actions: [] }
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations?*`, route => route.fulfill({ json: { items: [operation] } }))
  return { account, operation, now }
}

function item(id: string, title: string, now: string, content = 'not_requested', metrics = 'not_started') {
  return { platform_work_id: id, external_id: id, title, content_state: content, initial_metrics_state: metrics,
    last_seen_at: now, content_observed_at: null, error_code: content === 'failed' ? 'content_size_exceeded' : null }
}

test('同步明细可分页，正文与指标状态分别筛选，关闭后回到原进度', async ({ page }) => {
  const { account, now } = await setup(page)
  const requests: URL[] = []
  await page.route('**/platform-sync-operations/details-operation/items?*', route => {
    const url = new URL(route.request().url())
    requests.push(url)
    const stage = url.searchParams.get('stage')
    const state = url.searchParams.get('state')
    const second = url.searchParams.has('cursor')
    return route.fulfill({ json: { items: stage === 'metrics' ? [item('metrics', '仅指标失败的作品', now, 'complete', 'failed')]
      : state === 'failed' ? [item('failed', '正文读取失败的作品', now, 'failed', 'complete')]
      : [item(second ? 'page2' : 'page1', second ? '第二页作品' : '第一页作品', now)],
    next_cursor: !state && stage === 'content' && !second ? 'cursor+中文/&' : null } })
  })
  await page.goto(`/settings/accounts?id=${account.id}`)
  await page.getByRole('button', { name: '查看作品同步明细' }).click()
  const details = page.getByTestId('platform-sync-details')
  await expect(details.getByText('第一页作品')).toBeVisible()
  await expect(details.getByRole('listitem').getByText('尚未请求正文', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: '加载更多明细' }).click()
  await expect(details.getByText('第二页作品')).toBeVisible()
  expect(requests.some(url => url.searchParams.get('cursor') === 'cursor+中文/&')).toBeTruthy()
  await details.getByLabel('筛选同步状态').selectOption('failed')
  await expect(details.getByText('正文读取失败的作品')).toBeVisible()
  await expect(details.getByText('第一页作品')).toHaveCount(0)
  await expect(details.getByText(/错误码：content_size_exceeded/)).toBeVisible()
  await details.getByLabel('查看同步阶段').selectOption('metrics')
  await expect(details.getByLabel('筛选同步状态')).toHaveValue('')
  await details.getByLabel('筛选同步状态').selectOption('failed')
  await expect(details.getByText('仅指标失败的作品')).toBeVisible()
  await expect(details.getByText('正文读取失败的作品')).toHaveCount(0)
  expect(requests.at(-1)?.searchParams.get('stage')).toBe('metrics')
  expect(requests.at(-1)?.searchParams.get('state')).toBe('failed')
  await expect(details.getByRole('link', { name: '打开平台作品列表' })).toHaveAttribute('href', `/a/${account.id}/works?source=platform`)
  await page.screenshot({ path: '../../tmpverify/platform-sync-details.png' })
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看作品同步明细' })).toBeVisible()
})

test('明细错误可重试，同步终态自动刷新明细及账号资料', async ({ page }) => {
  const { account, operation, now } = await setup(page)
  operation.status = 'running'
  operation.stage = 'catalog'
  let fail = true
  let completed = false
  await page.route('**/platform-sync-operations/details-operation/items?*', route => fail
    ? route.fulfill({ status: 503, json: { error: { message: '明细服务暂不可用' } } })
    : route.fulfill({ json: { items: completed ? [item('last', '最后入库的作品明细', now)] : [], next_cursor: null } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-profile`, route => route.fulfill({ json: { snapshot: completed
    ? { display_name: '同步后自动回显的平台昵称', field_states: {}, observed_at: now } : null } }))
  await page.goto(`/settings/accounts?id=${account.id}`)
  await page.getByRole('button', { name: '查看作品同步明细' }).click()
  const details = page.getByTestId('platform-sync-details')
  await expect(details.getByRole('alert')).toContainText('明细服务暂不可用')
  await expect(details.getByText(/尚无可展示/)).toHaveCount(0)
  fail = false
  await details.getByRole('button', { name: '重试明细' }).click()
  await expect(details.getByText(/这不代表平台账号没有作品/)).toBeVisible()
  completed = true
  operation.status = 'partial'
  operation.stage = 'complete'
  operation.revision++
  await expect(details.getByText('最后入库的作品明细')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByText('同步后自动回显的平台昵称')).toBeVisible()
})

test('进度和资料读取失败各自可重试，不伪装成未同步', async ({ page }) => {
  const { account, operation, now } = await setup(page)
  let fail = true
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations?*`, route => fail
    ? route.fulfill({ status: 503, json: { error: { message: '进度服务暂不可用' } } })
    : route.fulfill({ json: { items: [operation] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-profile`, route => fail
    ? route.fulfill({ status: 503, json: { error: { message: '资料服务暂不可用' } } })
    : route.fulfill({ json: { snapshot: { display_name: '重试后平台昵称', field_states: {}, observed_at: now } } }))
  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(page.getByText(/同步进度读取失败：进度服务暂不可用/)).toBeVisible()
  await expect(page.getByText(/平台资料读取失败：资料服务暂不可用/)).toBeVisible()
  fail = false
  await page.getByRole('button', { name: '重试进度', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看作品同步明细' })).toBeVisible()
  await expect(page.getByText('重试后平台昵称')).toBeVisible()
  await expect(page.getByText(/同步进度读取失败/)).toHaveCount(0)
  await expect(page.getByText(/平台资料读取失败/)).toHaveCount(0)
})

test('明细下一页失败保留已加载作品，重试使用同一个游标', async ({ page }) => {
  const { account, now } = await setup(page)
  let failNext = true
  const cursors: Array<string | null> = []
  await page.route('**/platform-sync-operations/details-operation/items?*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    cursors.push(cursor)
    if (cursor && failNext) return route.fulfill({ status: 503, json: { error: { message: '下一页暂不可用' } } })
    return route.fulfill({ json: { items: [item(cursor ? 'next' : 'first', cursor ? '重试取得的下一页' : '已读取的第一页', now)], next_cursor: cursor ? null : 'next-cursor' } })
  })
  await page.goto(`/settings/accounts?id=${account.id}`)
  await page.getByRole('button', { name: '查看作品同步明细' }).click()
  const details = page.getByTestId('platform-sync-details')
  await expect(details.getByText('已读取的第一页')).toBeVisible()
  await details.getByRole('button', { name: '加载更多明细' }).click()
  await expect(details.getByRole('alert')).toContainText('下一页暂不可用')
  await expect(details.getByText('已读取的第一页')).toBeVisible()
  failNext = false
  await details.getByRole('button', { name: '重试明细' }).click()
  await expect(details.getByText('重试取得的下一页')).toBeVisible()
  await expect(details.getByRole('listitem')).toHaveCount(2)
  expect(cursors.slice(-2)).toEqual(['next-cursor', 'next-cursor'])
})

test('登录失效的恢复入口打开平台登录，限流提示要求本人核对恢复', async ({ page }) => {
  const { account, operation } = await setup(page)
  const error = { code: 'platform_login_required' }
  Object.assign(operation, { status: 'waiting_login', last_error: error })
  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings.getByText('请重新登录并核对这个平台账号，然后点击「继续同步」。')).toBeVisible()
  await page.evaluate(() => {
    const intents: string[] = []
    Object.assign(window, { __recoveryIntents: intents })
    window.open = (url) => { intents.push(String(url)); return null }
  })
  await settings.getByRole('button', { name: '重新核对平台登录', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__recoveryIntents)).toEqual([
    `ops-desktop://ui/platform-login/${account.id}/xhs`,
    'ops-desktop://ui/settings/account-device',
  ])
  error.code = 'platform_rate_limited'
  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(page.getByTestId('desktop-settings-window').getByText('读取已停止，请按平台提示核对限制；冷却后由本人确认恢复。')).toBeVisible()
})
