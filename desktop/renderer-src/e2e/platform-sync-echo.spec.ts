import { test, expect, type Page } from '@playwright/test'
import { api, preferDesktopAccount, registerAccount } from './support'

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
  return account
}

function operation(accountId: string, status = 'running') {
  return { id: 'sync-echo-fixture', account_id: accountId, kind: 'account_sync', revision: 2,
    status, stage: status === 'running' ? 'catalog' : 'complete', counters: { discovered: 2 }, coverage: {}, available_actions: [] }
}

function mirror(id: string, title: string) {
  return { id, title, remote_content_type: 'image_note', remote_status: 'published', content_state: 'not_requested',
    summary: '隔离测试样本', is_bound: false, last_seen_at: new Date().toISOString() }
}

test('同步结束后从空列表自动回显最后入库的作品，无需手动刷新', async ({ page }) => {
  const account = await setup(page)
  let status = 'running'
  let visible = false
  let mirrorReads = 0
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations**`, route => route.fulfill({ json: { items: [operation(account.id, status)] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-works?**`, route => {
    mirrorReads++
    return route.fulfill({ json: { items: visible ? [mirror('echo-final', '同步入库后自动显示的作品')] : [], next_cursor: null } })
  })
  await page.goto(`/a/${account.id}/works?source=platform`)
  await expect(page.getByText('正在同步平台作品', { exact: true })).toBeVisible()
  const before = mirrorReads
  visible = true
  status = 'partial'
  await expect(page.getByText('同步部分完成 · 结果整理 · 发现 2 篇')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByText('同步入库后自动显示的作品', { exact: true })).toBeVisible()
  expect(mirrorReads).toBeGreaterThan(before)
  await expect(page.getByText('正在同步平台作品', { exact: true })).toHaveCount(0)
})

test('失败终态不显示同步成功，作品接口失败可就地重试', async ({ page }) => {
  const account = await setup(page)
  let failed = true
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations**`, route => route.fulfill({ json: { items: [operation(account.id, 'failed')] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-works?**`, route => failed
    ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '平台作品读取暂不可用' } } })
    : route.fulfill({ json: { items: [], next_cursor: null } }))
  await page.goto(`/a/${account.id}/works?source=platform`)
  await expect(page.getByText('平台作品读取暂不可用')).toBeVisible({ timeout: 20_000 })
  failed = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText('上次同步失败', { exact: true })).toBeVisible()
  await expect(page.getByText('同步完成', { exact: true })).toHaveCount(0)
})

test('平台作品搜索和账号切换都使用自己的作用域', async ({ page }) => {
  const account = await setup(page)
  const other = await api(page, 'POST', '/accounts', { name: '另一个隔离验收号', platform: 'xhs', content_format: 'image_note' })
  const searches: string[] = []
  await page.route('**/api/v1/accounts/*/platform-sync-operations**', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/accounts/*/platform-works?**', route => {
    const url = new URL(route.request().url())
    const isOther = url.pathname.includes(other.id)
    searches.push(url.searchParams.get('q') ?? '')
    return route.fulfill({ json: { items: [mirror(isOther ? 'other-mirror' : 'first-mirror', isOther ? '另一个账号的作品' : '第一个账号的作品')], next_cursor: null } })
  })
  await page.goto(`/a/${account.id}/works?source=platform`)
  await expect(page.getByText('第一个账号的作品', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索平台作品', exact: true }).fill('带空格 & 中文')
  await expect.poll(() => searches).toContain('带空格 & 中文')
  await preferDesktopAccount(page, other.id)
  await page.goto(`/a/${other.id}/works?source=platform`)
  await expect(page.getByText('另一个账号的作品', { exact: true })).toBeVisible()
  await expect(page.getByText('第一个账号的作品', { exact: true })).toHaveCount(0)
})
