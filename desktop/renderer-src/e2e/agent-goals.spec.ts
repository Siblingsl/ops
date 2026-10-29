import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function goalJourney(page: Page, baseURL: string, screenshot: string) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw09-flow-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW09 目标验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW09 工作台 mock 模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const accountButton = page.getByRole('button', { name: '选择操作账号', exact: true })
  if (await accountButton.count()) await accountButton.click()
  else await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  await settings.getByRole('combobox', { name: '选择账号', exact: true }).selectOption(account.id)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  const sent = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.locator('textarea').last().fill('先简单核对近期运营表现。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await sent).status()).toBe(202)
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()

  await page.getByRole('button', { name: '任务目标与上下文整理' }).last().click()
  const desktop = page.locator('.desktop-agent-workbench')
  const panel = await desktop.count() > 0
    ? page.getByTestId('desktop-agent-side-panel')
    : page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '任务目标与上下文整理', exact: true }) })
  await panel.getByRole('button', { name: '设为任务', exact: true }).click()
  await panel.getByLabel('目标（最多 500 字）').fill('核对本周运营数据并给出一条可审阅建议')
  await panel.getByLabel('完成条件 1').fill('指出一个需要关注的运营变化')
  await panel.getByRole('button', { name: '保存并启用目标', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal?.status).toBe('active')
  await expect(panel.getByText('核对本周运营数据并给出一条可审阅建议', { exact: true })).toBeVisible()

  const taskFilter = page.getByRole('combobox', { name: '筛选对话状态', exact: true })
  if (await taskFilter.count()) {
    await taskFilter.selectOption('task')
    await expect(page.getByText('任务 · 进行中', { exact: true })).toBeVisible()
  }
  await panel.getByRole('button', { name: '预览整理范围与用量', exact: true }).click()
  await expect(panel.getByText('当前没有需要整理的旧消息。', { exact: true })).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshot}.png`) })
  return conversationID
}

async function assertHiddenGoalNotification(page: Page, conversationID: string) {
  await page.addInitScript(() => {
    const w = window as typeof window & { __opsTestNotifications?: Array<{ title: string; body?: string }>; __opsTestHidden?: boolean; __opsTestSources?: Array<any>; __opsTestEmitChanged?: () => void }
    w.__opsTestNotifications = []
    w.__opsTestSources = []
    class TestNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: (() => void) | null = null
      constructor(public title: string, public options?: { body?: string }) { w.__opsTestNotifications?.push({ title, body: options?.body }) }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__opsTestHidden ?? false })
    class TestEventSource {
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      listeners = new Map<string, () => void>()
      constructor() { w.__opsTestSources?.push(this); queueMicrotask(() => this.onopen?.()) }
      addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as () => void) }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: TestEventSource })
    w.__opsTestEmitChanged = () => w.__opsTestSources?.at(-1)?.listeners.get('changed')?.()
  })
  let inject = false
  let injectedRefresh = false
  await page.route('**/api/v1/notifications*', async (route) => {
    if (!inject) return route.continue()
    injectedRefresh = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      items: [{ id: 'aw09-hidden-goal-notification', kind: 'agent_goal', title: '敏感会话标题', body: '私密目标内容',
        link: `/agent/c/${conversationID}`, read_at: null, created_at: new Date().toISOString() }], unread: 1, active_jobs: 0, next_cursor: null,
    }) })
  })
  const initialNotifications = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/notifications' && response.request().method() === 'GET')
  await page.reload()
  await initialNotifications
  await page.getByRole('button', { name: '通知与 AI 任务', exact: true }).click()
  await page.getByRole('button', { name: '开启桌面提示', exact: true }).click()
  await expect(page.getByRole('button', { name: '关闭桌面提示', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__opsTestSources?.length ?? 0)).toBeGreaterThan(1)
  await expect.poll(() => page.evaluate(() => (window as any).__opsTestSources?.at(-1)?.listeners?.has('changed') ?? false)).toBe(true)
  await page.evaluate(() => {
    history.pushState({}, '', '/dashboard')
    window.dispatchEvent(new PopStateEvent('popstate'))
    ;(window as any).__opsTestHidden = true
    document.dispatchEvent(new Event('visibilitychange'))
  })
  inject = true
  await page.evaluate(() => (window as any).__opsTestEmitChanged?.())
  await expect.poll(() => injectedRefresh).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__opsTestNotifications?.length ?? 0)).toBe(1)
  const notices = await page.evaluate(() => (window as any).__opsTestNotifications)
  expect(notices).toEqual([{ title: 'AI 对话有结果', body: 'AI 对话有结果或需要处理' }])
}

test('DEV-AW09 Windows Electron任务目标与整理入口', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw09-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    const conversationID = await goalJourney(page, baseURL!, 'agent-workbench-aw09-electron')
    await assertHiddenGoalNotification(page, conversationID)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw09-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

