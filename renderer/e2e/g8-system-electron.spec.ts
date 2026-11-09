import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { toggleDesktopTheme } from './support'

test('DEV-QA26 G8 真实 Electron 命令面板、通知空态与主题重载', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-system-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-g8-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.getByRole('button', { name: /用户菜单/ })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    const search = palette.getByRole('textbox')
    await expect(palette).toBeVisible()
    await expect(search).toBeFocused()
    await expect(palette.getByText('操作', { exact: true })).toBeVisible()
    await expect(palette.getByText('设置', { exact: true })).toBeVisible()
    await search.fill('偏好设置')
    await expect(palette.getByRole('button', { name: '偏好设置', exact: true })).toBeVisible()
    await search.press('Enter')
    await expect(page).toHaveURL(/\/settings\/preferences$/)
    await expect(page.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '查看快捷键', exact: true }).click()
    const shortcuts = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '快捷键', exact: true }) })
    await expect(shortcuts).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shortcuts).toBeHidden()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(page.getByTestId('desktop-settings-window')).toBeHidden()

    const initialTheme = await page.locator('html').getAttribute('data-theme')
    const selectedTheme = initialTheme === 'dark' ? '浅色' : '深色'
    await toggleDesktopTheme(page, selectedTheme)
    const selectedValue = selectedTheme === '深色' ? 'dark' : 'light'
    await expect(page.locator('html')).toHaveAttribute('data-theme', selectedValue)
    expect(await page.evaluate(() => localStorage.getItem('ops-desktop-theme'))).toBe(selectedValue)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', selectedValue)
    if (initialTheme === 'dark' || initialTheme === 'light') {
      const restoreTheme = initialTheme === 'dark' ? '深色' : '浅色'
      await toggleDesktopTheme(page, restoreTheme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', initialTheme)
    }

    const panel = page.locator('.notification-panel')
    let panelOpened = false
    for (let attempt = 0; attempt < 3 && !panelOpened; attempt++) {
      const menuButton = page.getByRole('button', { name: /用户菜单/ })
      if (await menuButton.getAttribute('aria-expanded') !== 'true') await menuButton.click()
      panelOpened = await Promise.race([
        page.getByRole('menuitem', { name: /通知与 AI 任务/ }).click().then(() => true).catch(() => false),
        panel.waitFor({ state: 'visible' }).then(() => true).catch(() => false),
      ])
    }
    await expect(panel).toBeVisible()
    await expect(panel.getByText('暂无通知', { exact: true })).toBeVisible()
    const notificationTab = panel.getByRole('button', { name: '通知', exact: true })
    await expect(notificationTab).toBeVisible()
    await panel.getByRole('button', { name: 'AI 任务', exact: true }).click()
    await expect(panel.getByText('最近没有 AI 任务。关闭页面不会中断正在生成的内容，完成后会在这里和通知里提醒你。', { exact: true })).toBeVisible()

    const persistedLists = await page.evaluate(async () => {
      const [notifications, jobs] = await Promise.all([
        fetch('/api/v1/notifications').then((response) => response.json()),
        fetch('/api/v1/ai-jobs').then((response) => response.json()),
      ])
      return { notifications, jobs }
    })
    expect(persistedLists.notifications).toMatchObject({ items: [], unread: 0, active_jobs: 0 })
    expect(persistedLists.jobs).toEqual([])
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 仅关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !profile.includes('ops-qa26-g8-system-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G8-09 真实 Electron 智能体输入法组字不发送', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron 与本地 mock')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-ime-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-ime-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const call = async (method: string, path: string, body?: unknown) => page.evaluate(async ({ method, path, body }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch('/api/v1' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : null
    }, { method, path, body })

    const mockPort = new URL(baseURL!).port === '5387' ? '8397' : '8297'
    const provider = await call('POST', '/model-providers', {
      name: 'G8 输入法本地验收模型', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'local-e2e-key', models: ['mock-agent-tested'],
    })
    await call('POST', `/model-providers/${provider.id}/selftest`, {})
    await call('PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
    await page.goto(`${baseURL}/agent`)
    const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

    const composer = page.getByRole('textbox', { name: '发送消息' })
    const text = '桌面输入法'
    const cdp = await app.context().newCDPSession(page)
    const latency: number[] = []
    await composer.evaluate((element) => {
      const events: Array<{ key: string; isComposing: boolean; keyCode: number }> = []
      ;(element as HTMLElement & { __qa26KeyEvents?: typeof events }).__qa26KeyEvents = events
      element.addEventListener('keydown', (event) => events.push({ key: event.key, isComposing: event.isComposing, keyCode: event.keyCode }), true)
    })
    let conversationWrites = 0
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /^\/api\/v1\/agent\/conversations(?:\/[^/]+\/messages)?$/.test(path)) conversationWrites++
    })

    await composer.focus()
    for (let index = 0; index < 10; index++) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      const started = performance.now()
      await composer.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
      })))
      await expect(composer).toHaveValue(text)
      const event = await composer.evaluate((element) => (element as HTMLElement & { __qa26KeyEvents: Array<{ key: string; isComposing: boolean; keyCode: number }> }).__qa26KeyEvents.at(-1))
      expect(event).toMatchObject({ key: 'Enter', isComposing: true })
      latency.push(performance.now() - started)
    }
    for (let index = 0; index < 10; index++) {
      const started = performance.now()
      await composer.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 229, which: 229, bubbles: true, cancelable: true,
      })))
      await expect(composer).toHaveValue(text)
      const event = await composer.evaluate((element) => (element as HTMLElement & { __qa26KeyEvents: Array<{ key: string; isComposing: boolean; keyCode: number }> }).__qa26KeyEvents.at(-1))
      expect(event).toMatchObject({ key: 'Enter', isComposing: false, keyCode: 229 })
      latency.push(performance.now() - started)
    }
    expect(conversationWrites).toBe(0)
    expect((await call('GET', '/agent/conversations')).items).toHaveLength(0)
    const writesDuringComposition = conversationWrites

    await cdp.send('Input.insertText', { text })
    await expect(composer).toHaveValue(text)
    const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.keyboard.press('Enter')
    expect((await sendResponse).status()).toBe(202)
    await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
    const conversationID = page.url().split('/').pop()!
    await expect.poll(async () => (await call('GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
    const detail = await call('GET', `/agent/conversations/${conversationID}`)
    expect(detail.messages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content === text)).toHaveLength(1)

    const sorted = [...latency].sort((a, b) => a - b)
    const p50 = (sorted[Math.floor((sorted.length - 1) * 0.5)] + sorted[Math.ceil((sorted.length - 1) * 0.5)]) / 2
    console.log(`DEV-QA26 G8-09 IME event samples: ${JSON.stringify({ transport: 'CDP composition + DOM keyboard event', n: latency.length, p50_ms: p50, p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], conversationWritesDuringComposition: writesDuringComposition, persistedUserMessages: detail.messages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content === text).length })}`)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
      await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !profile.includes('ops-qa26-g8-ime-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
