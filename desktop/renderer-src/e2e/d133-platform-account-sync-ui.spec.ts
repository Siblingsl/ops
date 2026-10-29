import { test, expect, type Page } from '@playwright/test'
import { preferDesktopAccount, registerAccount } from './support'

async function electronPresentation(page: Page) {
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${agent} Electron/44.8.0` })
    const intents: string[] = []
    const resultListeners = new Set<(result: unknown) => void>()
    Object.defineProperty(window, '__platformAccountSyncIntents', { configurable: true, value: intents })
    Object.defineProperty(window, '__emitPlatformIntentResult', {
      configurable: true,
      value: (result: unknown) => resultListeners.forEach((listener) => listener(result)),
    })
    // 桌面桥面必须给全：DesktopSettingsHost 会同步调用 onOpenSettings/onLocalSettingsState，
    // 少一个就会在渲染期抛 TypeError 导致整页白屏。
    Object.defineProperty(window, 'opsDesktopUI', { configurable: true, value: {
      onOpenSettings: () => () => undefined,
      onLocalSettingsState: () => () => undefined,
      onPlatformIntentResult: (listener: (result: unknown) => void) => {
        resultListeners.add(listener)
        return () => resultListeners.delete(listener)
      },
    } })
    const originalOpen = window.open.bind(window)
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: (url: string | URL, ...args: unknown[]) => {
        const target = String(url)
        if (target.startsWith('ops-desktop://ui/platform-account-sync/')) {
          intents.push(target)
          return null
        }
        return originalOpen(url, ...(args as [string?, string?]))
      },
    })
  })
}

test('D-133 平台作品列表能力核验前禁用同步，核验后通过固定本机意图发起请求', async ({ page }) => {
  const account = await registerAccount(page)
  await preferDesktopAccount(page, account.id)
  await electronPresentation(page)
  await page.goto(`/a/${account.id}`)

  const connection = {
    id: 'platform-connection-e2e',
    account_id: account.id,
    platform: 'xhs',
    is_holder: true,
    state: 'active',
    availability: 'ready',
    external_account_key: 'xhs-e2e-account',
    auto_collect: false,
    auto_adopt: false,
    last_verified_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    next_due_at: null,
    failure_count: 0,
    authorization_revision: 7,
    adoption_revision: 1,
    platform_consent_version: 1,
    consented_at: new Date().toISOString(),
    sync_capabilities: { catalog: 'unknown', content: 'supported', metrics: 'supported' },
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
  let operationListReads = 0
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations**`, async (route) => {
    operationListReads += 1
    await route.fulfill({ json: { items: [] } })
  })

  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  const sync = settings.getByRole('button', { name: '同步平台账号', exact: true })
  await expect(sync).toBeDisabled()
  await expect(settings.getByText('平台作品列表读取能力尚未核验，暂不能同步账号。')).toBeVisible()

  connection.sync_capabilities.catalog = 'supported'
  await page.reload()
  const readySettings = page.getByTestId('desktop-settings-window')
  const readySync = readySettings.getByRole('button', { name: '同步平台账号', exact: true })
  await expect(readySync).toBeEnabled()
  await readySync.click()
  await expect(readySync).toBeDisabled()

  const intent = await page.evaluate(() => (window as any).__platformAccountSyncIntents[0] as string)
  const match = /^ops-desktop:\/\/ui\/platform-account-sync\/([0-9a-fA-F-]{36})\/(incremental|full_reconcile)\/(\d+)\/([0-9a-fA-F-]{36})$/.exec(intent)
  expect(match).not.toBeNull()
  if (!match) throw new Error(`Unexpected platform sync intent: ${intent}`)
  expect(match[1]).toBe(account.id)
  expect(match[2]).toBe('incremental')
  expect(Number(match[3])).toBe(7)
  expect(match[4]).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)

  const readsBeforeResult = operationListReads
  await page.evaluate((result) => (window as any).__emitPlatformIntentResult(result), {
    kind: 'platform-account-sync', requestId: match[4], accountId: account.id, status: 'queued',
  })
  await expect(page.getByText('已建立平台账号同步操作')).toBeVisible()
  await expect(readySync).toBeEnabled()
  await expect.poll(() => operationListReads).toBeGreaterThan(readsBeforeResult)
})
