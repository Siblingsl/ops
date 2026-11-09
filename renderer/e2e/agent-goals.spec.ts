import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { openDesktopAccountSwitcher } from './support'

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

async function assertGoalBudgetRecovery(page: Page, panel: ReturnType<Page['getByTestId']>, conversationID: string) {
  const started = performance.now()
  const submit = async (text: string) => {
    const accepted = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.locator('textarea').last().fill(text)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    return accepted
  }

  let detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.goal.run_budget).toBe(1)
  expect(detail.goal.used_runs).toBe(0)
  const firstRun = await submit('按当前目标继续核对一次。')
  expect((await firstRun).status()).toBe(202)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal?.status).toBe('budget_limited')
  detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.goal.used_runs).toBe(1)
  const limitedRunID = detail.last_run.id
  const userMessageCount = detail.messages.filter((message: { role: string }) => message.role === 'user').length
  await expect(panel.getByText('预算已用尽', { exact: true })).toBeVisible()

  const overBudget = await submit('预算用尽后不应再开始目标调用。')
  const overBudgetResponse = await overBudget
  const overBudgetBody = await overBudgetResponse.text()
  if (overBudgetResponse.status() === 202) {
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  }
  expect(overBudgetResponse.status(), overBudgetBody).toBe(429)
  expect(overBudgetBody).toContain('agent_goal_budget_reached')
  detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.last_run.id).toBe(limitedRunID)
  expect(detail.goal.used_runs).toBe(1)
  expect(detail.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(userMessageCount)

  const resumeWithoutBudget = page.waitForResponse((response) => /\/agent\/goals\/[^/]+\/control$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '恢复并继续', exact: true }).click()
  const refusedResume = await resumeWithoutBudget
  expect(refusedResume.status()).toBe(409)
  expect(await refusedResume.text()).toContain('agent_goal_budget_reached')
  expect((await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal?.status).toBe('budget_limited')

  await panel.getByRole('button', { name: '编辑目标', exact: true }).click()
  await panel.getByLabel('运行次数').fill('2')
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/conversations/${conversationID}/goal` && response.request().method() === 'PATCH')
  await panel.getByRole('button', { name: '保存新版本', exact: true }).click()
  expect((await saved).status()).toBe(200)
  detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 1 })

  const resumed = page.waitForResponse((response) => /\/agent\/goals\/[^/]+\/control$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '恢复并继续', exact: true }).click()
  const resumeResponse = await resumed
  expect(resumeResponse.status()).toBe(200)
  const resumeBody = await resumeResponse.json()
  expect(resumeBody.run_id).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  await expect.poll(async () => {
    const goal = (await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal
    return `${goal?.status}:${goal?.used_runs}`
  }).toBe('budget_limited:2')
  detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.last_run.id).toBe(resumeBody.run_id)
  await expect(panel.getByText('预算已用尽', { exact: true })).toBeVisible()
  console.log(`[DEV-QA26 goal-budget] ${JSON.stringify({ duration_ms: Math.round(performance.now() - started) })}`)
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
  // DEV-AW12 后桌面对话跟随当前账号，没有「对话设置」对话框：经顶部账号切换器切换。
  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tab', { name: /小红书/ }).click()
  await picker.getByRole('button', { name: 'AW09 目标验收号', exact: true }).click()
  await page.goto(`${baseURL}/agent`)
  await expect(page.locator('.desktop-agent-workbench-meta')).toContainText('AW09 目标验收号')
  const sent = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.locator('textarea').last().fill('先简单核对近期运营表现。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await sent).status()).toBe(202)
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()

  const desktop = page.locator('.desktop-agent-workbench')
  if (await desktop.count() > 0) {
    // 桌面形态：目标面板常驻「工作视图」侧栏，不再有独立的「任务目标与上下文整理」按钮。
    const panelButton = page.getByRole('button', { name: '工作视图', exact: true })
    if (await panelButton.getAttribute('aria-expanded') !== 'true') await panelButton.click()
  } else {
    await page.getByRole('button', { name: '任务目标与上下文整理' }).last().click()
  }
  const panel = await desktop.count() > 0
    ? page.getByTestId('desktop-agent-side-panel')
    : page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '任务目标与上下文整理', exact: true }) })
  await panel.getByRole('button', { name: '设为任务', exact: true }).click()
  await panel.getByLabel('目标（最多 500 字）').fill('核对本周运营数据并给出一条可审阅建议')
  await panel.getByLabel('完成条件 1').fill('指出一个需要关注的运营变化')
  await panel.getByLabel('运行次数').fill('1')
  await panel.getByRole('button', { name: '保存并启用目标', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal?.status).toBe('active')
  await expect(panel.getByText('核对本周运营数据并给出一条可审阅建议', { exact: true })).toBeVisible()

  const taskFilter = page.getByRole('combobox', { name: '筛选对话状态', exact: true })
  if (await taskFilter.count()) {
    await taskFilter.selectOption('task')
    await expect(page.getByText('任务 · 进行中', { exact: true })).toBeVisible()
  }
  await assertGoalBudgetRecovery(page, panel, conversationID)
  await panel.getByRole('button', { name: '预览整理范围与用量', exact: true }).click()
  await expect(panel.getByText('当前没有需要整理的旧消息。', { exact: true })).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/${screenshot}.png`) })
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
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: /通知与 AI 任务/ }).click()
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
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
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

test('DEV-QA26 G7-07 Windows Electron目标预算在整应用重启后保留并继续限流', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-g7-goal-restart-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const started = performance.now()
  try {
    const launch = () => _electron.launch({ executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    app = await launch()
    const initialPage = await app.firstWindow()
    const conversationID = await goalJourney(initialPage, baseURL!, `qa26-g7-goal-restart-${testInfo.repeatEachIndex}-${Date.now()}`)
    const beforeRestart = await initialPage.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
    const beforeGoal = await api(initialPage, 'GET', `/agent/conversations/${conversationID}`)
    expect(beforeGoal.goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 2 })
    const lastRunID = beforeGoal.last_run.id
    const userMessageCount = beforeGoal.messages.filter((message: { role: string }) => message.role === 'user').length

    await app.evaluate(({ app }) => app.exit(0))
    await app.close()
    app = undefined

    app = await launch()
    const page = await app.firstWindow()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const afterRestart = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
    expect(afterRestart.user_id).toBe(beforeRestart.user_id)
    await page.goto(`${baseURL}/agent/c/${conversationID}`)
    await expect(page.locator('.desktop-agent-workbench')).toBeVisible()
    const panelButton = page.getByRole('button', { name: '工作视图', exact: true })
    if (await panelButton.getAttribute('aria-expanded') !== 'true') await panelButton.click()
    const panel = page.getByTestId('desktop-agent-side-panel')
    await expect(panel.getByText('预算已用尽', { exact: true })).toBeVisible()

    let detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
    expect(detail.goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 2 })
    expect(detail.last_run.id).toBe(lastRunID)
    expect(detail.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(userMessageCount)

    const blockedMessage = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.locator('textarea').last().fill('重启后仍不能突破已用尽的目标预算。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const blockedResponse = await blockedMessage
    const blockedBody = await blockedResponse.text()
    expect(blockedResponse.status(), blockedBody).toBe(429)
    expect(blockedBody).toContain('agent_goal_budget_reached')

    detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
    expect(detail.goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 2 })
    expect(detail.last_run.id).toBe(lastRunID)
    expect(detail.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(userMessageCount)

    const refusedResume = page.waitForResponse((response) => /\/agent\/goals\/[^/]+\/control$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '恢复并继续', exact: true }).click()
    const refusedResumeResponse = await refusedResume
    const refusedResumeBody = await refusedResumeResponse.text()
    expect(refusedResumeResponse.status(), refusedResumeBody).toBe(409)
    expect(refusedResumeBody).toContain('agent_goal_budget_reached')
    expect((await api(page, 'GET', `/agent/conversations/${conversationID}`)).goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 2 })

    await testInfo.attach('qa26-g7-goal-restart.json', { body: Buffer.from(JSON.stringify({
      conversation_id: conversationID, user_id: beforeRestart.user_id, goal: detail.goal,
      last_run_id: lastRunID, user_message_count: userMessageCount,
      blocked_message_status: blockedResponse.status(), blocked_message_code: 'agent_goal_budget_reached',
      refused_resume_status: refusedResumeResponse.status(), refused_resume_code: 'agent_goal_budget_reached',
      duration_ms: Math.round(performance.now() - started),
    }, null, 2)), contentType: 'application/json' })
    console.log(`[DEV-QA26 G7-07 app-restart] ${JSON.stringify({ duration_ms: Math.round(performance.now() - started), user_id: beforeRestart.user_id, conversation_id: conversationID, persisted_budget: detail.goal.run_budget, used_runs: detail.goal.used_runs, blocked_message_status: blockedResponse.status(), refused_resume_status: refusedResumeResponse.status() })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-g7-goal-restart-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7-07 Windows Electron两设备同时竞争最后一份目标预算只接受一个运行', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const firstUserData = await mkdtemp(join(tmpdir(), 'ops-qa26-g7-goal-race-first-'))
  const secondUserData = await mkdtemp(join(tmpdir(), 'ops-qa26-g7-goal-race-second-'))
  let firstApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let secondApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const started = performance.now()
  try {
    const launch = (userData: string) => _electron.launch({ executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    firstApp = await launch(firstUserData)
    const firstPage = await firstApp.firstWindow()
    const conversationID = await goalJourney(firstPage, baseURL!, `qa26-g7-goal-race-${testInfo.repeatEachIndex}-${Date.now()}`)
    const me = await firstPage.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
    const beforeRaise = await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)
    expect(beforeRaise.goal).toMatchObject({ status: 'budget_limited', run_budget: 2, used_runs: 2 })
    const userMessageCount = beforeRaise.messages.filter((message: { role: string }) => message.role === 'user').length
    const firstPanelButton = firstPage.getByRole('button', { name: '工作视图', exact: true })
    if (await firstPanelButton.getAttribute('aria-expanded') !== 'true') await firstPanelButton.click()
    const firstPanel = firstPage.getByTestId('desktop-agent-side-panel')
    await firstPanel.getByRole('button', { name: '编辑目标', exact: true }).click()
    await firstPanel.getByLabel('运行次数').fill('4')
    const savedGoal = firstPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/conversations/${conversationID}/goal` && response.request().method() === 'PATCH')
    await firstPanel.getByRole('button', { name: '保存新版本', exact: true }).click()
    expect((await savedGoal).status()).toBe(200)
    const raisedGoal = await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)
    expect(raisedGoal.goal).toMatchObject({ status: 'budget_limited', run_budget: 4, used_runs: 2 })
    const resume = firstPage.waitForResponse((response) => /\/agent\/goals\/[^/]+\/control$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await firstPanel.getByRole('button', { name: '恢复并继续', exact: true }).click()
    const resumed = await resume
    expect(resumed.status()).toBe(200)
    await expect.poll(async () => {
      const goal = (await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)).goal
      return `${goal?.status}:${goal?.used_runs}`
    }).toBe('active:3')
    await expect.poll(async () => (await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()

    secondApp = await launch(secondUserData)
    const secondPage = await secondApp.firstWindow()
    await secondPage.goto(`${baseURL}/login`)
    await secondPage.getByLabel('用户名', { exact: true }).fill(me.username)
    await secondPage.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await secondPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => secondPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await secondPage.goto(`${baseURL}/agent`)
    const privacy = secondPage.getByRole('dialog').filter({ has: secondPage.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    if (await privacy.count()) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await openDesktopAccountSwitcher(secondPage)
    const picker = secondPage.getByTestId('desktop-context-menu')
    await picker.getByRole('tab', { name: /小红书/ }).click()
    await picker.getByRole('button', { name: 'AW09 目标验收号', exact: true }).click()
    await secondPage.goto(`${baseURL}/agent/c/${conversationID}`)
    await expect(secondPage.locator('.desktop-agent-workbench')).toBeVisible()
    const secondPanelButton = secondPage.getByRole('button', { name: '工作视图', exact: true })
    if (await secondPanelButton.getAttribute('aria-expanded') !== 'true') await secondPanelButton.click()
    await expect(secondPage.getByTestId('desktop-agent-side-panel').getByText('核对本周运营数据并给出一条可审阅建议', { exact: true })).toBeVisible()

    const firstResponse = firstPage.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    const secondResponse = secondPage.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await Promise.all([
      firstPage.locator('textarea').last().fill('第一台设备竞争最后一份目标预算。'),
      secondPage.locator('textarea').last().fill('第二台设备竞争最后一份目标预算。'),
    ])
    const clickStarted = performance.now()
    await Promise.all([
      firstPage.getByRole('button', { name: '发送', exact: true }).click(),
      secondPage.getByRole('button', { name: '发送', exact: true }).click(),
    ])
    const responses = await Promise.all([firstResponse, secondResponse])
    const statuses = responses.map((response) => response.status()).sort((left, right) => left - right)
    expect(statuses).toEqual([202, 409])
    const rejected = responses.find((response) => response.status() === 409)!
    expect(await rejected.text()).toContain('agent_run_busy')
    const accepted = responses.find((response) => response.status() === 202)!
    const acceptedBody = await accepted.json()
    expect(acceptedBody.run_id).toBeTruthy()
    const clickDuration = Math.round(performance.now() - clickStarted)

    await expect.poll(async () => (await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
    const afterRace = await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)
    expect(afterRace.goal).toMatchObject({ status: 'budget_limited', run_budget: 4, used_runs: 4 })
    expect(afterRace.last_run.id).toBe(acceptedBody.run_id)
    expect(afterRace.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(userMessageCount + 1)
    const afterBudgetMessage = firstPage.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await firstPage.locator('textarea').last().fill('两设备运行结束且目标预算用尽后不应继续创建运行。')
    await firstPage.getByRole('button', { name: '发送', exact: true }).click()
    const budgetResponse = await afterBudgetMessage
    expect(budgetResponse.status()).toBe(429)
    expect(await budgetResponse.text()).toContain('agent_goal_budget_reached')
    const finalDetail = await api(firstPage, 'GET', `/agent/conversations/${conversationID}`)
    expect(finalDetail.goal).toMatchObject({ status: 'budget_limited', run_budget: 4, used_runs: 4 })
    expect(finalDetail.last_run.id).toBe(acceptedBody.run_id)
    expect(finalDetail.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(userMessageCount + 1)
    const evidence = { conversation_id: conversationID, user_id: me.user_id, statuses,
      conflict_code: 'agent_run_busy', accepted_run_id: acceptedBody.run_id, goal: finalDetail.goal,
      budget_limited_message_status: budgetResponse.status(), budget_limited_message_code: 'agent_goal_budget_reached',
      user_messages_before: userMessageCount,
      user_messages_after: finalDetail.messages.filter((message: { role: string }) => message.role === 'user').length,
      concurrent_click_to_responses_ms: clickDuration, duration_ms: Math.round(performance.now() - started) }
    await testInfo.attach('qa26-g7-goal-cross-device-race.json', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
    console.log(`[DEV-QA26 G7-07 cross-device-race] ${JSON.stringify(evidence)}`)
  } finally {
    await secondApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await secondApp?.close()
    await firstApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await firstApp?.close()
    for (const userData of [firstUserData, secondUserData]) {
      if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-g7-goal-race-')) throw new Error('拒绝清理测试目录之外路径')
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})

