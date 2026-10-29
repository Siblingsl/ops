import { test, expect, type Page } from '@playwright/test'
import { preferDesktopAccount, registerAccount } from './support'

// 业务窗口拿不到 opsDesktopSettings，指标刷新与继续同步只能走固定本机意图：
// 这里伪造桌面桥面，断言深链格式、回执匹配与列表重读，和 d133 的账号同步用例同构。
async function electronPresentation(page: Page) {
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${agent} Electron/44.8.0` })
    const intents: string[] = []
    const resultListeners = new Set<(result: unknown) => void>()
    Object.defineProperty(window, '__platformIntents', { configurable: true, value: intents })
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
        if (target.startsWith('ops-desktop://ui/platform-metrics-refresh/') || target.startsWith('ops-desktop://ui/platform-sync-resume/')) {
          intents.push(target)
          return null
        }
        return originalOpen(url, ...(args as [string?, string?]))
      },
    })
  })
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

test('D-148 指标刷新与继续同步通过固定本机意图发起，并按 requestId 匹配回执', async ({ page }) => {
  const account = await registerAccount(page)
  await electronPresentation(page)
  await page.goto(`/a/${account.id}`)

  const now = new Date().toISOString()
  const connection = {
    id: 'platform-connection-d148',
    account_id: account.id,
    platform: 'xhs',
    is_holder: true,
    state: 'active',
    availability: 'ready',
    external_account_key: 'xhs-d148-account',
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
  const pausedOperation = {
    id: '2f0d3c1e-0c4a-4c2e-9b3e-5a6d7c8e9f01',
    kind: 'account_sync',
    effective_mode: 'incremental',
    revision: 4,
    status: 'paused',
    stage: 'catalog',
    account_id: account.id,
    connection_id: connection.id,
    created_at: now,
    scope_upper_bound: null,
    expires_at: null,
    next_allowed_at: null,
    pause_reason: 'user_paused',
    coverage: null,
    counters: { discovered: 3 },
    last_error: null,
    available_actions: ['resume', 'cancel'],
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
    await route.fulfill({ json: { items: [pausedOperation] } })
  })

  await preferDesktopAccount(page, account.id)
  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  const refresh = settings.getByRole('button', { name: '刷新作品指标', exact: true })
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(refresh).toBeDisabled()

  const metricsIntent = await page.evaluate(() => (window as any).__platformIntents[0] as string)
  const metricsMatch = /^ops-desktop:\/\/ui\/platform-metrics-refresh\/([0-9a-fA-F-]{36})\/(\d+)\/([0-9a-fA-F-]{36})$/.exec(metricsIntent)
  expect(metricsMatch).not.toBeNull()
  if (!metricsMatch) throw new Error(`Unexpected metrics intent: ${metricsIntent}`)
  expect(metricsMatch[1]).toBe(account.id)
  expect(Number(metricsMatch[2])).toBe(7)
  expect(metricsMatch[3]).toMatch(UUID_PATTERN)

  const readsBeforeMetrics = operationListReads
  await page.evaluate((result) => (window as any).__emitPlatformIntentResult(result), {
    kind: 'platform-metrics-refresh', requestId: metricsMatch[3], accountId: account.id, status: 'queued', operationId: crypto.randomUUID(),
  })
  await expect(page.getByText('已建立作品指标刷新操作')).toBeVisible()
  await expect(refresh).toBeEnabled()
  await expect.poll(() => operationListReads).toBeGreaterThan(readsBeforeMetrics)

  const resume = settings.getByRole('button', { name: '继续同步', exact: true })
  await expect(resume).toBeEnabled()
  await resume.click()
  await expect(resume).toBeDisabled()

  const resumeIntent = await page.evaluate(() => (window as any).__platformIntents[1] as string)
  const resumeMatch = /^ops-desktop:\/\/ui\/platform-sync-resume\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})\/(\d+)\/([0-9a-fA-F-]{36})$/.exec(resumeIntent)
  expect(resumeMatch).not.toBeNull()
  if (!resumeMatch) throw new Error(`Unexpected resume intent: ${resumeIntent}`)
  expect(resumeMatch[1]).toBe(account.id)
  expect(resumeMatch[2]).toBe(pausedOperation.id)
  expect(Number(resumeMatch[3])).toBe(pausedOperation.revision)
  expect(resumeMatch[4]).toMatch(UUID_PATTERN)

  const readsBeforeResume = operationListReads
  await page.evaluate((result) => (window as any).__emitPlatformIntentResult(result), {
    kind: 'platform-sync-resume', requestId: resumeMatch[4], accountId: account.id, operationId: pausedOperation.id, status: 'queued',
  })
  await expect(page.getByText('同步已继续')).toBeVisible()
  await expect.poll(() => operationListReads).toBeGreaterThan(readsBeforeResume)
})

test('D-148 指标刷新失败回执只提示服务端原因，不残留忙碌状态', async ({ page }) => {
  const account = await registerAccount(page)
  await electronPresentation(page)
  await page.goto(`/a/${account.id}`)

  const now = new Date().toISOString()
  await page.route('**/api/v1/platform-collection/policy', (route) => route.fulfill({ json: {
    global_enabled: true,
    account_sync_platforms: ['xhs'],
    metrics_refresh_platforms: ['xhs'],
    policy: { enabled: true, allow_member_connections: true },
  } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-connection`, (route) => route.fulfill({ json: { connection: {
    id: 'platform-connection-d148-fail',
    account_id: account.id,
    platform: 'xhs',
    is_holder: true,
    state: 'active',
    availability: 'ready',
    external_account_key: 'xhs-d148-fail',
    auto_collect: false,
    auto_adopt: false,
    last_verified_at: now,
    last_seen_at: now,
    next_due_at: null,
    failure_count: 0,
    authorization_revision: 3,
    adoption_revision: 1,
    platform_consent_version: 1,
    consented_at: now,
    sync_capabilities: { catalog: 'supported', content: 'supported', metrics: 'supported' },
  } } }))
  await page.route(`**/api/v1/accounts/${account.id}/metrics/observations`, (route) => route.fulfill({ json: { observations: [] } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-profile`, (route) => route.fulfill({ json: { snapshot: null, state: 'unknown' } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-sync-operations**`, (route) => route.fulfill({ json: { items: [] } }))

  await preferDesktopAccount(page, account.id)
  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  const refresh = settings.getByRole('button', { name: '刷新作品指标', exact: true })
  await expect(refresh).toBeEnabled()
  await refresh.click()

  const intent = await page.evaluate(() => (window as any).__platformIntents[0] as string)
  const match = /^ops-desktop:\/\/ui\/platform-metrics-refresh\/([0-9a-fA-F-]{36})\/(\d+)\/([0-9a-fA-F-]{36})$/.exec(intent)
  if (!match) throw new Error(`Unexpected metrics intent: ${intent}`)

  await page.evaluate((result) => (window as any).__emitPlatformIntentResult(result), {
    kind: 'platform-metrics-refresh', requestId: match[3], accountId: account.id, status: 'failed', message: '只有连接保管人的主设备可以发起平台读取',
  })
  await expect(page.getByText('只有连接保管人的主设备可以发起平台读取')).toBeVisible()
  await expect(refresh).toBeEnabled()
})
