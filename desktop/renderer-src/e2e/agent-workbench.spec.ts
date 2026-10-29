import { _electron, expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

test('DEV-AW02 Electron 工作台布局、响应式、键盘与主题保持输入状态', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5287')
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  const provider = await api(page, 'POST', '/model-providers', {
    name: '工作台验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const workspace = page.locator('.desktop-agent-workbench')
  await expect(workspace).toBeVisible()
  await expect(page.getByRole('heading', { name: '从一件具体的运营任务开始', exact: true })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await expect(composer).toHaveAttribute('rows', '3')
  const example = '这周有哪些作品还没做发布前检查？'
  await page.getByRole('button', { name: example, exact: true }).click()
  await expect(composer).toHaveValue(example)
  await expect(page).toHaveURL(/\/agent$/)
  await expect(workspace.locator('.desktop-agent-workbench-prompt')).toHaveCount(3)

  await page.getByRole('button', { name: '任务面板', exact: true }).click()
  const panel = page.getByTestId('desktop-agent-side-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('tab', { name: '上下文', exact: true }).click()
  await expect(panel.getByText('操作账号', { exact: true })).toBeVisible()
  await expect(panel.getByText('模型', { exact: true })).toBeVisible()

  await page.keyboard.press('Control+Shift+B')
  await expect(workspace).toHaveAttribute('data-list-collapsed', 'true')
  await page.keyboard.press('Control+Shift+B')
  await expect(workspace).toHaveAttribute('data-list-collapsed', 'false')
  await page.keyboard.press('Control+Shift+J')
  await expect(panel).toBeHidden()
  await page.keyboard.press('Control+Shift+F')
  await expect(page.getByRole('textbox', { name: '搜索对话' })).toBeFocused()
  await page.keyboard.press('Control+Shift+J')
  await expect(panel).toBeVisible()

  const composerHandle = await composer.elementHandle()
  await page.getByRole('button', { name: '切换到深色主题', exact: true }).click()
  await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  expect(await composerHandle?.evaluate((element) => element === document.querySelector('[aria-label="发送消息"]'))).toBeTruthy()
  await expect(composer).toHaveValue(example)
  await page.getByRole('button', { name: '切换到浅色主题', exact: true }).click()
  await expect(composer).toHaveValue(example)
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../../.playwright-results/agent-workbench-aw02.png') })

  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(workspace).toBeVisible()
    const bounds = await workspace.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(bounds.scrollWidth, `${width}px 工作台不应产生横向滚动`).toBeLessThanOrEqual(bounds.clientWidth + 1)
  }

  await page.keyboard.press('Control+Shift+O')
  await expect(page).toHaveURL(/\/agent$/)
  await expect(composer).toHaveValue('')
  const messageText = 'AW02 当前对话完整历史检索验收'
  await composer.fill(`#text ${messageText}`)
  const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await sendResponse).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  await page.locator('.desktop-agent-chat-stream').click({ position: { x: 20, y: 30 } })
  await page.keyboard.press('Control+f')
  const localSearch = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '查找当前对话', exact: true }) })
  await expect(localSearch).toBeVisible()
  await localSearch.getByRole('textbox', { name: '搜索当前对话' }).fill(messageText)
  await localSearch.getByRole('button', { name: '查找', exact: true }).click()
  const result = localSearch.getByRole('button', { name: /AW02 当前对话完整历史检索验收/ }).first()
  await expect(result).toBeVisible()
  await result.click()
  await expect(localSearch).toBeHidden()
  await expect(page.locator('[data-message-seq]').filter({ hasText: messageText }).first()).toBeVisible()
})

test('DEV-AW04 Electron 工作台可搜索并预览真实上下文', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5287')
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW04 Electron 工作台验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  const materialText = `AW04-桌面上下文-${Date.now()}：桌面工作台预览真实资料。`
  await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: materialText, source: 'AW04 桌面验收' })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const workbench = page.locator('.desktop-agent-workbench')
  await expect(workbench).toBeVisible()
  await page.getByRole('button', { name: '选择操作账号' }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  await settings.getByRole('combobox', { name: '选择账号' }).selectOption(account.id)
  await settings.getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '引用资料（@）' }).click()
  const contextDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '引用工作区资料', exact: true }) })
  await contextDialog.getByRole('textbox', { name: '搜索资料' }).fill(materialText)
  const materialCandidate = contextDialog.getByRole('button', { name: new RegExp(materialText) })
  await expect(materialCandidate).toBeVisible()
  await materialCandidate.click()
  await contextDialog.getByRole('button', { name: '预览并校验', exact: true }).click()
  await expect(contextDialog.locator('pre')).toContainText(materialText)
  await contextDialog.getByRole('button', { name: '添加引用', exact: true }).click()
  await expect(contextDialog).toBeHidden()
  await expect(page.getByRole('button', { name: `移除引用 ${materialText}`, exact: true })).toBeVisible()
  await expect(page.getByText('本轮引用', { exact: true })).toBeVisible()

  const screenshotDir = resolve(process.cwd(), '../../.playwright-results')
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, 'agent-workbench-aw04-electron-context.png') })
})

async function prepareAW05(page: import('@playwright/test').Page, desktop: boolean) {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW05 产物验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'AW05 产物预览来源作品' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '小步持续改进' })
  if (desktop) {
    await page.addInitScript(() => {
      const userAgent = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    })
  }
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const instruction = [
    '生成标题候选，并提出一张等待我单独审阅的标题卡片。',
    `#tool load_tool_domain {"domain":"works"}`,
    `#tool works__list {"accountId":"${account.id}"}`,
    `#tool load_tool_domain {"domain":"writing"}`,
    `#tool works__titles {"id":"${work.id}"}`,
    `#tool works__update {"id":"${work.id}","title":"小步持续改进"}`,
  ].join('\n')
  const composer = desktop ? page.getByRole('textbox', { name: '发送消息' }) : page.getByPlaceholder(/发送消息/)
  await composer.fill(instruction)
  const response = page.waitForResponse((item) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(item.url()).pathname) && item.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  const detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.actions).toHaveLength(1)
  return { work, conversationID, action: detail.actions[0] }
}

test('DEV-AW02 真实 Electron 浅深主题与桌面窗口宽度', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实客户端验收需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '真实客户端验收仅连接本地 mock 服务')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-workbench-aw02-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`agent-aw02-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const setupModel = async () => page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const call = async (path: string, method: string, body: unknown) => {
        const response = await fetch(`/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify(body) })
        const text = await response.text()
        if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
        return text ? JSON.parse(text) : null
      }
      const provider = await call('/model-providers', 'POST', { name: 'Electron 工作台 mock', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'] })
      await call(`/model-providers/${provider.id}/selftest`, 'POST', {})
      await call('/model-routes', 'PUT', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
    })
    await setupModel()
    await page.goto(`${baseURL}/agent`)
    const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(privacy).toBeHidden()
    const workspace = page.locator('.desktop-agent-workbench')
    await expect(workspace).toBeVisible()
    const composer = page.getByRole('textbox', { name: '发送消息' })
    await expect(composer).toHaveAttribute('rows', '3')

    const setWindowWidth = async (width: number) => {
      await app!.evaluate(({ BrowserWindow }, nextWidth) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('/agent')) ?? BrowserWindow.getAllWindows()[0]
        window.setBounds({ x: 0, y: 40, width: nextWidth - 1, height: 900 })
      }, width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      const bounds = await workspace.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
      expect(bounds.scrollWidth, `${width}px Electron 窗口不应产生工作台横向滚动`).toBeLessThanOrEqual(bounds.clientWidth + 1)
    }
    const screenshotDir = resolve(process.cwd(), '../../.playwright-results')
    mkdirSync(screenshotDir, { recursive: true })
    for (const width of [1366, 1440, 1920]) {
      await setWindowWidth(width)
      if (width === 1440) await page.screenshot({ path: resolve(screenshotDir, 'agent-workbench-aw02-electron-light.png') })
    }
    const composerHandle = await composer.elementHandle()
    await page.getByRole('button', { name: '切换到深色主题', exact: true }).click()
    await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
    expect(await composerHandle?.evaluate((element) => element === document.querySelector('[aria-label="发送消息"]'))).toBeTruthy()
    await page.screenshot({ path: resolve(screenshotDir, 'agent-workbench-aw02-electron-dark.png') })
    await page.getByRole('button', { name: '切换到浅色主题', exact: true }).click()
  } finally {
    await app?.close()
    await rm(userData, { recursive: true, force: true })
  }
})

test('DEV-AW05 桌面侧栏预览产物并定位到唯一卡片表单', async ({ page, baseURL }) => {
  test.setTimeout(30_000)
  expect(baseURL).toBe('http://127.0.0.1:5287')
  const { work, action } = await prepareAW05(page, true)
  await page.getByRole('button', { name: '任务面板', exact: true }).click()
  const panel = page.getByTestId('desktop-agent-side-panel')
  await expect(panel).toBeVisible()
  const card = page.locator(`#agent-action-${action.id}`)
  await expect(card).toHaveCount(1)
  await panel.getByRole('button', { name: '定位操作卡片', exact: true }).click()
  await expect(card).toBeFocused()
  await panel.getByRole('tab', { name: '产物', exact: true }).click()
  await expect(panel.getByRole('button', { name: /标题候选/ })).toBeVisible()
  await expect(panel.getByText('小步持续改进', { exact: true })).toBeVisible()
  await expect(panel.getByRole('link', { name: '打开来源作品', exact: true })).toHaveAttribute('href', `/works/${work.id}`)
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../../.playwright-results/agent-workbench-aw05-desktop-artifact.png') })
})

