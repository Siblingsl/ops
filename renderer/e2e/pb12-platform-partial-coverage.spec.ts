import { test, expect, type Page } from '@playwright/test'
import { preferDesktopAccount, registerAccount } from './support'

async function electronPresentation(page: Page) {
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${agent} Electron/44.8.0` })
    // 桌面桥面必须给全：DesktopSettingsHost 会同步调用 onOpenSettings/onLocalSettingsState，
    // 平台操作统一通过单一 onPlatformIntentResult 回执订阅检查能力。
    Object.defineProperty(window, 'opsDesktopUI', { configurable: true, value: {
      onOpenSettings: () => () => undefined,
      onLocalSettingsState: () => () => undefined,
      onPlatformIntentResult: () => () => undefined,
    } })
  })
}

test('PB-12 shows partial platform sync coverage and a safe next step', async ({ page }) => {
  const account = await registerAccount(page)
  await preferDesktopAccount(page, account.id)
  await electronPresentation(page)
  await page.goto(`/a/${account.id}`)

  const now = new Date().toISOString()
  const connection = {
    id: 'platform-connection-pb12',
    account_id: account.id,
    platform: 'xhs',
    is_holder: true,
    state: 'active',
    availability: 'ready',
    external_account_key: 'xhs-pb12-account',
    auto_collect: false,
    auto_adopt: false,
    last_verified_at: now,
    last_seen_at: now,
    next_due_at: null,
    failure_count: 0,
    authorization_revision: 7,
    adoption_revision: 1,
    platform_consent_version: 1,
    consented_at: now,
    sync_capabilities: { catalog: 'supported', content: 'supported', metrics: 'supported' },
  }

  await page.route('**/api/v1/platform-collection/policy', (route) => route.fulfill({ json: {
    global_enabled: true,
    account_sync_platforms: ['xhs'],
    metrics_refresh_platforms: ['xhs'],
    policy: { enabled: true, allow_member_connections: true },
  } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-connection`, (route) => route.fulfill({ json: { connection } }))
  await page.route(`**/api/v1/accounts/${account.id}/metrics/observations`, (route) => route.fulfill({ json: { observations: [] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-profile`, (route) => route.fulfill({ json: { snapshot: null, state: 'unknown' } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations**`, (route) => route.fulfill({ json: { items: [{
    id: 'platform-sync-pb12',
    kind: 'account_sync',
    effective_mode: 'incremental',
    revision: 2,
    status: 'succeeded',
    stage: 'complete',
    account_id: account.id,
    connection_id: connection.id,
    created_at: now,
    scope_upper_bound: null,
    expires_at: null,
    next_allowed_at: null,
    pause_reason: null,
    coverage: {
      pages_read: 2,
      has_more: true,
      incomplete_reason: 'page_repeated',
      retryable: false,
      profile: { state: 'complete', reason: null },
      catalog: { state: 'partial', reason: 'catalog_inconsistent' },
      content: { state: 'not_started', reason: null },
      metrics: { state: 'not_started', reason: null },
    },
    counters: { discovered: 18 },
    last_error: null,
    available_actions: [],
  }] } }))

  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  const coverage = settings.getByTestId('platform-sync-coverage')

  await expect(coverage).toBeVisible()
  await expect(settings.getByText('部分完成').first()).toBeVisible()
  await expect(coverage.getByText('已读取 2 页')).toBeVisible()
  await expect(coverage.getByText('还有后续页面')).toBeVisible()
  await expect(coverage.getByText('作品列表边界发生变化，无法确认覆盖完整')).toBeVisible()
  await expect(coverage.getByText('平台重复返回同一页，无法确认列表是否读完')).toBeVisible()
  await expect(coverage.getByText('不可直接重试')).toBeVisible()
  await expect(coverage.getByRole('link', { name: '查看已采集的平台作品' })).toHaveAttribute('href', `/a/${account.id}/works?source=platform`)
  await expect(coverage.getByRole('button', { name: '重新核对历史作品' })).toBeEnabled()
})
