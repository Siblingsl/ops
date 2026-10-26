import { _electron, expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

test('DEV-AW03 分组、未读、搜索、归档与恢复可从会话列表完成', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5179')
  await registerAccount(page)
  const conversation = await api(page, 'POST', '/agent/conversations', {})
  const title = 'AW03 会话组织与归档验收'
  await api(page, 'PATCH', `/agent/conversations/${conversation.id}`, { expected_revision: conversation.revision, title })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  await expect(page.getByRole('button', { name: '新建分组', exact: true })).toBeVisible()
  const groupResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/conversation-groups' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '新建分组', exact: true }).click()
  const groupDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建私有分组', exact: true }) })
  await groupDialog.getByRole('textbox', { name: '分组名称' }).fill('本周选题')
  await groupDialog.getByRole('button', { name: '保存', exact: true }).click()
  const group = await (await groupResponse).json()

  const rowButton = page.getByRole('button', { name: new RegExp(title) })
  await expect(rowButton).toBeVisible()
  const row = rowButton.locator('xpath=..')
  await row.getByRole('button', { name: '对话操作' }).click()
  await page.getByRole('menuitem', { name: '移动到分组', exact: true }).click()
  const moveDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '移动到分组', exact: true }) })
  await moveDialog.getByRole('combobox', { name: '选择分组' }).selectOption(group.id)
  await moveDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversation.id}`)).conversation.group_id).toBe(group.id)

  const updatedRow = page.getByRole('button', { name: new RegExp(title) }).locator('xpath=..')
  await updatedRow.getByRole('button', { name: '对话操作' }).click()
  await page.getByRole('menuitem', { name: '标为未读', exact: true }).click()
  await page.getByRole('combobox', { name: '筛选对话状态' }).selectOption('unread')
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
  const searchBox = page.getByRole('textbox', { name: '搜索对话' })
  const noMatchSearch = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/v1/agent/conversations' && url.searchParams.get('q') === 'AW03-明确无匹配-xyz'
  })
  await searchBox.fill('AW03-明确无匹配-xyz')
  await noMatchSearch
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0)
  const matchingSearch = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/v1/agent/conversations' && url.searchParams.get('q') === 'AW03 会话组织'
  })
  await searchBox.fill('AW03 会话组织')
  await matchingSearch
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()

  await page.getByRole('combobox', { name: '筛选归档状态' }).selectOption('archived')
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0)
  await page.getByRole('combobox', { name: '筛选归档状态' }).selectOption('active')
  const activeRow = page.getByRole('button', { name: new RegExp(title) }).locator('xpath=..')
  await activeRow.getByRole('button', { name: '对话操作' }).click()
  await page.getByRole('menuitem', { name: '归档', exact: true }).click()
  await page.getByRole('combobox', { name: '筛选归档状态' }).selectOption('archived')
  const archivedRow = page.getByRole('button', { name: new RegExp(title) }).locator('xpath=..')
  await expect(archivedRow).toBeVisible()
  await archivedRow.getByRole('button', { name: '对话操作' }).click()
  await page.getByRole('menuitem', { name: '恢复归档', exact: true }).click()
  await expect.poll(async () => !!(await api(page, 'GET', `/agent/conversations/${conversation.id}`)).conversation.archived_at).toBe(false)

  await page.getByRole('button', { name: /管理分组/ }).click()
  const manageDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '管理私有分组', exact: true }) })
  await manageDialog.getByRole('button', { name: `删除分组 ${group.name}`, exact: true }).click()
  await page.getByRole('button', { name: '删除分组', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversation.id}`)).conversation.group_id).toBe(null)
})

test('DEV-AW02 Electron 工作台布局、响应式、键盘与主题保持输入状态', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5179')
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  const provider = await api(page, 'POST', '/model-providers', {
    name: '工作台验收模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
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
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-workbench-aw02.png') })

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

test('DEV-AW02 Web 即使服务端开放桌面工作台功能仍保留原页面', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:5179')
  await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'Web 工作台兼容模型', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto('/agent')
  await expect(page.locator('.desktop-agent-workbench')).toHaveCount(0)
  await expect(page.getByPlaceholder(/发送消息/)).toBeVisible()
})

test('DEV-AW02 真实 Electron 浅深主题与桌面窗口宽度', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实客户端验收需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '真实客户端验收仅连接本地 mock 服务')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-workbench-aw02-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
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
      const provider = await call('/model-providers', 'POST', { name: 'Electron 工作台 mock', base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'] })
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
    const screenshotDir = resolve(process.cwd(), '../.playwright-results')
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
